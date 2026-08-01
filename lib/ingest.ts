/**
 * Ingest: the path every inbound message takes.
 *
 *   validate -> policy lookup -> origin gate -> idempotency -> suppression
 *            -> (digest buffer | enqueue | send inline for P0)
 *
 * Priority, audience, transport and digest behaviour all come from the policy
 * table, never from the caller. A project can request a priority but the
 * registry clamps it, so nothing can label its own broadcast as urgent.
 */

import { one, query } from './db.ts';
import { admit, type Priority } from './quota.ts';
import { buffer, forceFlush, renderTemplate, shouldEscalate, type DigestWindow, type FlushDeps } from './digest.ts';
import { judgeOrigin } from './origin.ts';
import { loadProjectLimits, loadQuotaSnapshot } from './queue.ts';
import { checkSuppressed } from './suppression.ts';
import { countsAgainstQuota, pickTransport, transports } from './transports/index.ts';
import { listUnsubscribeHeaders } from './unsubscribe.ts';
import { digestTemplate } from './render.ts';
import type {
  Attachment, Audience, DigestItem, MessageRow, PolicyRow, ProjectRow, TransportName,
} from './types.ts';
import { normalizeSeverity, TransportError } from './types.ts';

/** Vercel caps a serverless request body at 4.5 MB; base64 inflates by ~33%. */
export const MAX_ATTACHMENT_B64_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_ATTACHMENT_BYTES = 3 * 1024 * 1024;

export interface SendRequest {
  event?: string;
  to: string;
  toName?: string;
  subject?: string;
  html?: string;
  text?: string;
  fromName?: string;
  replyTo?: string;
  priority?: Priority;
  audience?: Audience;
  /**
   * Accepts the caller's own vocabulary (MEDQIZE and HR- send
   * CRITICAL/HIGH/MEDIUM/LOW) and is normalized before storage.
   */
  severity?: string;
  locale?: string;
  dir?: 'rtl' | 'ltr';
  attachments?: Attachment[];
  headers?: Record<string, string>;
  idempotencyKey?: string;
  sourceOrigin?: string;
  /** Tier B/C: structured payload instead of rendered HTML. */
  template?: 'otp' | 'notice';
  data?: Record<string, unknown>;
  item?: DigestItem;
  dedupeKey?: string;
}

export type IngestOutcome =
  | { status: 'sent'; id: string; provider_id: string | null; transport: TransportName }
  | { status: 'queued'; id: string; priority: Priority; scheduled_at: string }
  | { status: 'buffered'; digest_key: string; flush_at: string; occurrences: number }
  | { status: 'suppressed'; reason: string }
  | { status: 'dropped'; reason: string }
  | { status: 'duplicate'; id: string; original_status: string }
  | { status: 'error'; error: string; http: number; retry_after?: number };

// ── policy resolution ───────────────────────────────────────────────────────

async function resolvePolicy(projectId: number, event: string): Promise<PolicyRow | null> {
  return one<PolicyRow>(
    `SELECT * FROM notification_policies WHERE project_id = $1 AND event_type = $2 AND active`,
    [projectId, event],
  );
}

/**
 * An unregistered event still sends — it just gets conservative defaults.
 * Refusing unknown events would mean a forgotten policy row silently breaks a
 * password reset in production, which is a far worse failure than sending one
 * email at a cautious priority.
 */
function defaultPolicy(projectId: number, event: string): PolicyRow {
  return {
    id: -1, project_id: projectId, event_type: event,
    priority: 2, audience: 'user', delivery_mode: 'immediate',
    digest_key_template: null, dedupe_key_template: null, flush_threshold: 25,
    escalate_when: null, escalated_priority: null, transport_hint: null,
    ttl_seconds: null, honors_unsubscribe: true, active: true,
  };
}

async function ttlFor(priority: Priority, policy: PolicyRow): Promise<number> {
  if (policy.ttl_seconds) return policy.ttl_seconds;
  const row = await one<{ ttl_seconds: number }>(`SELECT ttl_seconds FROM quota_policy WHERE priority = $1`, [priority]);
  return row?.ttl_seconds || 86_400;
}

// ── enqueue ─────────────────────────────────────────────────────────────────

interface EnqueueArgs {
  project: ProjectRow;
  policy: PolicyRow;
  priority: Priority;
  req: SendRequest;
  subject: string;
  html: string | null;
  text: string | null;
  transport: TransportName;
  sourceOrigin: string | null;
  batchId?: string | null;
  digestOf?: string | null;
}

async function insertMessage(args: EnqueueArgs): Promise<MessageRow> {
  const { project, policy, priority, req } = args;
  const domain = process.env.MAIL_DOMAIN || 'localhost';
  const fromAddress = `${project.from_local_part}@${domain}`;
  const ttl = await ttlFor(priority, policy);

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  // Only discretionary mail advertises an unsubscribe control.
  if (priority >= 3 && policy.honors_unsubscribe) {
    Object.assign(headers, listUnsubscribeHeaders({ project: project.slug, email: req.to, scope: 'global' }));
  }

  const row = await one<MessageRow>(
    `INSERT INTO messages
       (project_id, event_type, priority, audience, to_address, to_name,
        from_name, from_address, reply_to, subject, html, text, headers,
        locale, dir, transport, idempotency_key, dedupe_key, batch_id, digest_of,
        source_origin, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
             NOW() + ($22 || ' seconds')::interval)
     RETURNING *`,
    [
      project.id, policy.event_type, priority, policy.audience, req.to, req.toName ?? null,
      req.fromName ?? project.default_from_name, fromAddress, req.replyTo ?? project.reply_to,
      args.subject, args.html, args.text, JSON.stringify(headers),
      req.locale ?? project.default_locale, req.dir ?? project.default_dir, args.transport,
      req.idempotencyKey ?? null, req.dedupeKey ?? null, args.batchId ?? null, args.digestOf ?? null,
      args.sourceOrigin, String(ttl),
    ],
  );
  if (!row) throw new Error('Failed to enqueue message');

  if (req.attachments?.length) {
    for (const a of req.attachments) {
      const size = a.content ? Buffer.byteLength(a.content, 'utf8') : 0;
      await query(
        `INSERT INTO message_attachments (message_id, filename, content_type, content_b64, remote_url, byte_size)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, a.filename, a.content_type ?? 'application/octet-stream', a.content ?? null, a.url ?? null, size],
      );
    }
  }
  return row;
}

/** Injected into the digest engine so a flushed digest becomes a real message. */
export const flushDeps: FlushDeps = {
  async enqueueDigest({ projectId, toAddress, subject, html, text, digestKey, flushBatch }) {
    const project = await one<ProjectRow>(`SELECT * FROM projects WHERE id = $1`, [projectId]);
    if (!project) throw new Error(`Unknown project ${projectId} for digest ${digestKey}`);

    const policy: PolicyRow = { ...defaultPolicy(projectId, `gateway.digest.${digestKey}`), audience: 'owner', priority: 2 };
    const row = await insertMessage({
      project, policy, priority: 2,
      req: { to: toAddress, subject, dir: 'ltr', locale: 'en' },
      subject, html, text,
      // Digests go over Resend like everything else; Gmail only catches them
      // if the budget is already gone.
      transport: pickTransport({
        audience: 'owner', priority: 2, transportHint: null,
        allowedTransports: project.allowed_transports, resendExhausted: false,
        dryRun: process.env.DRY_RUN === 'true' || project.dry_run,
      }),
      sourceOrigin: null,
      digestOf: flushBatch,
    });
    return row.id;
  },
};

// ── the main entry point ────────────────────────────────────────────────────

export async function ingest(project: ProjectRow, req: SendRequest): Promise<IngestOutcome> {
  if (!req.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.to)) {
    return { status: 'error', error: 'a valid `to` address is required', http: 400 };
  }

  const event = req.event ?? `${project.slug}.legacy`;
  const policy = (await resolvePolicy(project.id, event)) ?? defaultPolicy(project.id, event);

  if (policy.delivery_mode === 'suppress') {
    return { status: 'dropped', reason: 'policy: suppress' };
  }

  // ── origin gate: kills the "localhost frontend against prod backend" spam ──
  const verdict = judgeOrigin(req.sourceOrigin, project.production_origins ?? []);
  if (!verdict.production) {
    // Recorded, not silently discarded — it must stay visible in the dashboard.
    await query(
      `INSERT INTO messages
         (project_id, event_type, priority, audience, to_address, from_name, from_address,
          subject, status, status_reason, source_origin, transport, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'dropped',$9,$10,'noop', NOW())`,
      [
        project.id, event, policy.priority, policy.audience, req.to,
        project.default_from_name, `${project.from_local_part}@${process.env.MAIL_DOMAIN ?? 'localhost'}`,
        req.subject ?? '(dropped)', `non-production origin: ${verdict.reason}`, verdict.host,
      ],
    ).catch(() => {});
    return { status: 'dropped', reason: `non-production origin (${verdict.reason})` };
  }

  // ── idempotency: a replay returns the original, it never sends twice ──
  if (req.idempotencyKey) {
    const existing = await one<{ id: string; status: string }>(
      `SELECT id, status FROM messages WHERE project_id = $1 AND idempotency_key = $2`,
      [project.id, req.idempotencyKey],
    );
    if (existing) return { status: 'duplicate', id: existing.id, original_status: existing.status };
  }

  // Caller may request a priority but the registry clamps how good it can be.
  const requested = req.priority ?? policy.priority;
  let priority = Math.max(requested, project.best_priority) as Priority;

  // The RAW severity goes into the escalation context on purpose, so a policy
  // can match the project's own vocabulary — {"severity":["CRITICAL"]} or
  // {"severity":["HIGH"]} — rather than our normalized three levels.
  const ctx: Record<string, unknown> = {
    event_type: event, severity: req.severity ?? 'info', data: req.data ?? {}, to: req.to,
  };
  const severity = normalizeSeverity(req.severity);
  const escalated = shouldEscalate(policy, ctx);
  if (escalated && policy.escalated_priority !== null) priority = policy.escalated_priority;

  const suppression = await checkSuppressed(req.to, priority, project.slug, policy.honors_unsubscribe);
  if (suppression.suppressed) return { status: 'suppressed', reason: suppression.reason ?? 'suppressed' };

  // ── digest path ──
  const isDigest = policy.delivery_mode.startsWith('digest:');
  if (isDigest && !escalated) {
    const mode = policy.delivery_mode.split(':')[1] as DigestWindow;
    const digestKey = renderTemplate(policy.digest_key_template ?? 'owner:daily', ctx);
    const dedupeKey = renderTemplate(policy.dedupe_key_template ?? '{{event_type}}', ctx) || event;
    const item: DigestItem = req.item ?? {
      title: req.subject ?? event,
      summary: req.text ?? undefined,
      severity,
      dir: req.dir ?? project.default_dir,
    };
    return buffer({
      projectId: project.id, digestKey, toAddress: req.to, dedupeKey,
      priority, severity, item, mode,
    });
  }

  // An escalated item force-flushes the buffer it would have joined, so the
  // alarm arrives together with its context rather than an hour ahead of it.
  if (isDigest && escalated && policy.digest_key_template) {
    const digestKey = renderTemplate(policy.digest_key_template, ctx);
    forceFlush(digestKey, req.to, flushDeps).catch(() => {});
  }

  // ── render ──
  let subject = req.subject ?? '';
  let html = req.html ?? null;
  let text = req.text ?? null;

  if (req.template) {
    const { otpTemplate, noticeTemplate } = await import('./render.ts');
    const dir = req.dir ?? project.default_dir;
    if (req.template === 'otp') {
      const t = otpTemplate({
        code: String(req.data?.code ?? ''),
        minutes: Number(req.data?.minutes ?? 5),
        appName: project.display_name,
        dir,
      });
      html = t.html; text = t.text;
      subject ||= dir === 'rtl' ? 'رمز التحقق' : 'Your verification code';
    } else {
      const t = noticeTemplate({
        heading: String(req.data?.heading ?? subject),
        body: String(req.data?.body ?? ''),
        link: req.data?.link as { label: string; url: string } | undefined,
        appName: project.display_name,
        dir,
      });
      html = t.html; text = t.text;
      subject ||= String(req.data?.heading ?? project.display_name);
    }
  }

  if (!subject) return { status: 'error', error: '`subject` is required', http: 400 };
  if (!html && !text) return { status: 'error', error: 'one of `html` or `text` is required', http: 400 };

  // ── attachment limits ──
  let totalBytes = 0;
  for (const a of req.attachments ?? []) {
    if (!a.content && !a.url) return { status: 'error', error: `attachment ${a.filename} has neither content nor url`, http: 400 };
    if (a.content) {
      const size = Buffer.byteLength(a.content, 'utf8');
      totalBytes += size;
      if (size > MAX_ATTACHMENT_B64_BYTES) {
        return { status: 'error', error: `attachment ${a.filename} exceeds ${MAX_ATTACHMENT_B64_BYTES} bytes base64 — pass a url instead`, http: 413 };
      }
    }
  }
  if (totalBytes > MAX_REQUEST_ATTACHMENT_BYTES) {
    return { status: 'error', error: `attachments total exceeds ${MAX_REQUEST_ATTACHMENT_BYTES} bytes`, http: 413 };
  }

  // ── admission ──
  const [snapshot, limits] = await Promise.all([loadQuotaSnapshot(), loadProjectLimits(project.id)]);
  const decision = admit(snapshot, priority, limits);
  const dryRun = process.env.DRY_RUN === 'true' || project.dry_run;

  const transport = pickTransport({
    audience: policy.audience,
    priority,
    transportHint: policy.transport_hint,
    allowedTransports: project.allowed_transports,
    resendExhausted: !decision.ok,
    dryRun,
  });

  if (countsAgainstQuota(transport) && !decision.ok) {
    if (priority === 0) {
      // A blocked user is waiting and there is no capacity and no fallback.
      // Say so explicitly so the app can show the code on screen instead.
      return { status: 'error', error: 'quota_exhausted', http: 503, retry_after: 900 };
    }
    if (decision.reason === 'project_daily_cap' || decision.reason === 'project_monthly_cap') {
      return { status: 'error', error: decision.reason, http: 429, retry_after: 3600 };
    }
    // Everything else is queued rather than refused — it will drain later.
  }

  const row = await insertMessage({
    project, policy, priority, req, subject, html, text, transport,
    sourceOrigin: verdict.host,
  });

  // P0 is sent inline: a queued OTP that waits for the next drain tick is a
  // failed login. Everything else is the queue's job.
  if (priority === 0 && (decision.ok || !countsAgainstQuota(transport))) {
    try {
      await query(`UPDATE messages SET status='attempting', attempts=1, claimed_at=NOW() WHERE id=$1`, [row.id]);
      const res = await transports[transport]({
        from: `"${row.from_name}" <${row.from_address}>`,
        to: row.to_address,
        replyTo: row.reply_to,
        subject: row.subject,
        html: row.html,
        text: row.text,
        headers: row.headers ?? {},
        attachments: req.attachments ?? [],
        idempotencyKey: row.id,
      });
      await query(`UPDATE messages SET status='sent', provider_id=$2, sent_at=NOW() WHERE id=$1`, [row.id, res.id]);
      return { status: 'sent', id: row.id, provider_id: res.id, transport };
    } catch (err) {
      const te = err instanceof TransportError ? err : new TransportError('server', String(err));
      // Leave it queued so the drain loop retries — do not lose an OTP because
      // one HTTP call failed.
      await query(
        `UPDATE messages SET status='queued', claimed_at=NULL, last_error=$2, scheduled_at=NOW() WHERE id=$1`,
        [row.id, te.message.slice(0, 500)],
      );
      return { status: 'queued', id: row.id, priority, scheduled_at: new Date().toISOString() };
    }
  }

  return { status: 'queued', id: row.id, priority, scheduled_at: row.scheduled_at.toISOString() };
}

export { digestTemplate };
