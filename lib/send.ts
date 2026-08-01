/**
 * The send path. One function, start to finish, synchronous.
 *
 *   validate -> origin gate -> idempotency -> suppression -> flood cooldown
 *            -> pick transport -> SEND NOW -> record
 *
 * There is no queue and no scheduler. A request arrives, the email goes out,
 * the caller gets the real result. If Resend's daily budget is spent the
 * message goes over Gmail instead; nothing is ever deferred or dropped for
 * quota reasons.
 *
 * The checks that remain are the ones that are not about quota at all:
 *   - the origin gate stops a localhost frontend emailing real alerts
 *   - suppression stops mailing addresses that bounced or complained, which
 *     protects a domain reputation shared by every project
 *   - idempotency stops a retry or double-click sending twice
 *   - the flood cooldown stops one broken endpoint sending 47 identical alerts
 *
 * Failures are retried inline twice; anything still failing is parked in the
 * database and retried by the next inbound request. No cron involved.
 */

import { one, query } from './db.ts';
import { judgeOrigin } from './origin.ts';
import { checkSuppressed } from './suppression.ts';
import { transports } from './transports/index.ts';
import { isConfigured as gmailConfigured } from './transports/gmail.ts';
import { listUnsubscribeHeaders } from './unsubscribe.ts';
import { noticeTemplate, otpTemplate, shell } from './render.ts';
import { DEFAULT_DAILY_BUDGET, evaluate } from './quota.ts';
import type { Attachment, Audience, MessageRow, ProjectRow, TransportName } from './types.ts';
import { normalizeSeverity, TransportError } from './types.ts';

/** Vercel caps a serverless request body at 4.5 MB; base64 inflates by ~33%. */
export const MAX_ATTACHMENT_B64_BYTES = 2 * 1024 * 1024;
export const MAX_REQUEST_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SendRequest {
  event?: string;
  to: string;
  toName?: string;
  subject?: string;
  html?: string;
  text?: string;
  fromName?: string;
  replyTo?: string;
  audience?: Audience;
  /** Caller's own vocabulary (CRITICAL/HIGH/...) — normalized before storage. */
  severity?: string;
  locale?: string;
  dir?: 'rtl' | 'ltr';
  attachments?: Attachment[];
  headers?: Record<string, string>;
  idempotencyKey?: string;
  sourceOrigin?: string;
  /** Central templates, so a new project never writes email HTML. */
  template?: 'otp' | 'notice';
  data?: Record<string, unknown>;
  /**
   * Repeats of the same key inside the cooldown window are counted, not sent.
   * Use it for error alerts.
   */
  dedupeKey?: string;
  /** Marketing-ish mail advertises an unsubscribe control. */
  bulk?: boolean;
}

export type SendOutcome =
  | { status: 'sent'; id: string; provider_id: string | null; transport: TransportName }
  | { status: 'failed'; id: string; error: string; will_retry: boolean }
  | { status: 'suppressed'; reason: string }
  | { status: 'dropped'; reason: string }
  | { status: 'throttled'; reason: string; occurrences: number }
  | { status: 'duplicate'; id: string; original_status: string }
  | { status: 'error'; error: string; http: number };

// ── policy (only what still matters) ────────────────────────────────────────

interface Policy {
  event_type: string;
  audience: Audience;
  honors_unsubscribe: boolean;
  /** Seconds to suppress identical dedupe_key repeats. 0 = never throttle. */
  cooldown_seconds: number;
  transport_hint: TransportName | null;
}

async function resolvePolicy(projectId: number, event: string): Promise<Policy> {
  const row = await one<Policy>(
    `SELECT event_type, audience, honors_unsubscribe,
            COALESCE(cooldown_seconds, 0) AS cooldown_seconds, transport_hint
       FROM notification_policies
      WHERE project_id = $1 AND event_type = $2 AND active`,
    [projectId, event],
  );
  // An unregistered event still sends. A forgotten policy row must never be
  // the reason a password reset silently fails.
  return row ?? {
    event_type: event, audience: 'user', honors_unsubscribe: true,
    cooldown_seconds: 0, transport_hint: null,
  };
}

// ── quota: one count, one decision ──────────────────────────────────────────

async function currentQuota() {
  const [used, budgetRow] = await Promise.all([
    one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages
        WHERE transport = 'resend' AND status IN ('sent','sending')
          AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '24 hours'`,
    ),
    one<{ v: string }>(`SELECT v FROM quota_settings WHERE k = 'daily_budget'`),
  ]);
  return evaluate({
    usedToday: Number(used?.n ?? 0),
    budget: Number(budgetRow?.v ?? DEFAULT_DAILY_BUDGET),
  });
}

/**
 * Resend carries everything — it is the only sender on the verified domain and
 * the only one that reliably reaches an inbox. Gmail is the overflow valve for
 * when the daily budget is genuinely spent: unauthenticated for this domain and
 * far more likely to land in spam, but a message in spam beats one never sent.
 */
function pickTransport(policy: Policy, project: ProjectRow, resendAvailable: boolean, dryRun: boolean): TransportName {
  if (dryRun) return 'noop';
  const allowed = (t: TransportName) =>
    project.allowed_transports.includes(t) && (t !== 'gmail' || gmailConfigured());
  if (policy.transport_hint && allowed(policy.transport_hint)) return policy.transport_hint;
  if (!resendAvailable && allowed('gmail')) return 'gmail';
  return 'resend';
}

// ── flood cooldown ──────────────────────────────────────────────────────────

/**
 * Suppress identical repeats for a while, and count them.
 *
 * This is not a quota measure — it is inbox sanity. One broken endpoint
 * generating 47 identical alerts should produce one email, not 47. Both
 * projects already did exactly this before the gateway existed; it is kept
 * because it was right.
 */
async function throttled(projectId: number, dedupeKey: string, seconds: number): Promise<number | null> {
  if (!dedupeKey || seconds <= 0) return null;
  const row = await one<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM messages
      WHERE project_id = $1 AND dedupe_key = $2
        AND created_at > NOW() - ($3 || ' seconds')::interval`,
    [projectId, dedupeKey, String(seconds)],
  );
  const n = Number(row?.n ?? 0);
  return n > 0 ? n + 1 : null;
}

// ── the send ────────────────────────────────────────────────────────────────

export async function send(project: ProjectRow, req: SendRequest): Promise<SendOutcome> {
  if (!req.to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.to)) {
    return { status: 'error', error: 'a valid `to` address is required', http: 400 };
  }

  const event = req.event ?? `${project.slug}.legacy`;
  const policy = await resolvePolicy(project.id, event);
  const severity = normalizeSeverity(req.severity);

  // ── origin gate ──
  const verdict = judgeOrigin(req.sourceOrigin, project.production_origins ?? []);
  if (!verdict.production) {
    await recordTerminal(project, event, req, 'dropped', `non-production origin: ${verdict.reason}`, verdict.host);
    return { status: 'dropped', reason: `non-production origin (${verdict.reason})` };
  }

  // ── idempotency ──
  if (req.idempotencyKey) {
    const existing = await one<{ id: string; status: string }>(
      `SELECT id, status FROM messages WHERE project_id = $1 AND idempotency_key = $2`,
      [project.id, req.idempotencyKey],
    );
    if (existing) return { status: 'duplicate', id: existing.id, original_status: existing.status };
  }

  // ── suppression ──
  const supp = await checkSuppressed(req.to, req.bulk ? 3 : 0, project.slug, policy.honors_unsubscribe);
  if (supp.suppressed) return { status: 'suppressed', reason: supp.reason ?? 'suppressed' };

  // ── flood cooldown ──
  const repeats = await throttled(project.id, req.dedupeKey ?? '', policy.cooldown_seconds);
  if (repeats !== null) {
    return { status: 'throttled', reason: `identical to a message sent in the last ${policy.cooldown_seconds}s`, occurrences: repeats };
  }

  // ── render ──
  let subject = req.subject ?? '';
  let html = req.html ?? null;
  let text = req.text ?? null;

  if (req.template) {
    const dir = req.dir ?? project.default_dir;
    if (req.template === 'otp') {
      const t = otpTemplate({
        code: String(req.data?.code ?? ''), minutes: Number(req.data?.minutes ?? 5),
        appName: project.display_name, dir,
      });
      html = t.html; text = t.text;
      subject ||= dir === 'rtl' ? 'رمز التحقق' : 'Your verification code';
    } else {
      const t = noticeTemplate({
        heading: String(req.data?.heading ?? subject), body: String(req.data?.body ?? ''),
        link: req.data?.link as { label: string; url: string } | undefined,
        appName: project.display_name, dir,
      });
      html = t.html; text = t.text;
      subject ||= String(req.data?.heading ?? project.display_name);
    }
  } else if (html && !/^\s*<(!doctype|html)/i.test(html) && req.data?.wrap !== false) {
    // Bare fragments get the standard shell; complete documents are passed
    // through untouched, which is what keeps existing project templates intact.
    if (!/<body[\s>]/i.test(html)) {
      html = shell(html, { dir: req.dir ?? project.default_dir, title: subject });
    }
  }

  if (!subject) return { status: 'error', error: '`subject` is required', http: 400 };
  if (!html && !text) return { status: 'error', error: 'one of `html` or `text` is required', http: 400 };

  // ── attachment limits ──
  let total = 0;
  for (const a of req.attachments ?? []) {
    if (!a.content && !a.url) return { status: 'error', error: `attachment ${a.filename} has neither content nor url`, http: 400 };
    if (a.content) {
      const size = Buffer.byteLength(a.content, 'utf8');
      total += size;
      if (size > MAX_ATTACHMENT_B64_BYTES) {
        return { status: 'error', error: `attachment ${a.filename} exceeds ${MAX_ATTACHMENT_B64_BYTES} bytes base64 — pass a url instead`, http: 413 };
      }
    }
  }
  if (total > MAX_REQUEST_ATTACHMENT_BYTES) {
    return { status: 'error', error: `attachments total exceeds ${MAX_REQUEST_ATTACHMENT_BYTES} bytes`, http: 413 };
  }

  // ── transport ──
  const quota = await currentQuota();
  const dryRun = process.env.DRY_RUN === 'true' || project.dry_run;
  const transport = pickTransport(policy, project, quota.resendAvailable, dryRun);

  const domain = process.env.MAIL_DOMAIN || 'localhost';
  const fromAddress = `${project.from_local_part}@${domain}`;
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  if (req.bulk && policy.honors_unsubscribe) {
    Object.assign(headers, listUnsubscribeHeaders({ project: project.slug, email: req.to, scope: 'global' }));
  }

  // Recorded as 'sending' BEFORE the call: a request that times out after the
  // provider accepted it consumed quota we would otherwise never count.
  const row = await one<MessageRow>(
    `INSERT INTO messages
       (project_id, event_type, audience, to_address, to_name, from_name, from_address,
        reply_to, subject, html, text, headers, locale, dir, status, transport,
        idempotency_key, dedupe_key, source_origin, severity)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'sending',$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      project.id, event, policy.audience, req.to, req.toName ?? null,
      req.fromName ?? project.default_from_name, fromAddress, req.replyTo ?? project.reply_to,
      subject, html, text, JSON.stringify(headers),
      req.locale ?? project.default_locale, req.dir ?? project.default_dir, transport,
      req.idempotencyKey ?? null, req.dedupeKey ?? null, verdict.host, severity,
    ],
  );
  if (!row) return { status: 'error', error: 'could not record the message', http: 500 };

  if (req.attachments?.length) {
    for (const a of req.attachments) {
      await query(
        `INSERT INTO message_attachments (message_id, filename, content_type, content_b64, remote_url, byte_size)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, a.filename, a.content_type ?? 'application/octet-stream',
         a.content ?? null, a.url ?? null, a.content ? Buffer.byteLength(a.content, 'utf8') : 0],
      );
    }
  }

  return deliver(row, req.attachments ?? [], transport, project);
}

/**
 * Hand the message to a transport, retrying transient failures inline.
 *
 * Two quick retries only. Anything still failing is left `failed` with
 * `retry_after` set; the next inbound request picks it up (see retryParked).
 * Nothing here waits on a scheduler.
 */
async function deliver(
  row: MessageRow,
  attachments: Attachment[],
  transport: TransportName,
  project: ProjectRow,
): Promise<SendOutcome> {
  const outbound = {
    from: `"${row.from_name}" <${row.from_address}>`,
    to: row.to_address,
    replyTo: row.reply_to,
    subject: row.subject,
    html: row.html,
    text: row.text,
    headers: row.headers ?? {},
    attachments,
    // Stable across retries, so a retry can never double-send.
    idempotencyKey: row.id,
  };

  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await transports[transport](outbound);
      await query(
        `UPDATE messages SET status='sent', provider_id=$2, sent_at=NOW(), attempts=attempts+1, last_error=NULL WHERE id=$1`,
        [row.id, res.id],
      );
      return { status: 'sent', id: row.id, provider_id: res.id, transport };
    } catch (err) {
      const te = err instanceof TransportError ? err : new TransportError('server', String((err as Error)?.message ?? err));
      lastError = te.message;

      // Provider says the budget is gone — switch to Gmail and try again
      // immediately rather than failing. This is the whole fallback story.
      if (te.kind === 'quota' && transport === 'resend' && project.allowed_transports.includes('gmail') && gmailConfigured()) {
        transport = 'gmail';
        await query(`UPDATE messages SET transport='gmail' WHERE id=$1`, [row.id]);
        continue;
      }
      if (!te.retryable) break;
      await sleep(400 * (attempt + 1));
    }
  }

  await query(
    `UPDATE messages SET status='failed', attempts=attempts+1, last_error=$2,
            retry_after = NOW() + INTERVAL '2 minutes' WHERE id=$1`,
    [row.id, lastError.slice(0, 500)],
  );
  return { status: 'failed', id: row.id, error: lastError, will_retry: true };
}

async function recordTerminal(
  project: ProjectRow, event: string, req: SendRequest,
  status: string, reason: string, origin: string | null,
) {
  await query(
    `INSERT INTO messages
       (project_id, event_type, audience, to_address, from_name, from_address,
        subject, status, status_reason, source_origin, transport)
     VALUES ($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,'noop')`,
    [
      project.id, event, req.to, project.default_from_name,
      `${project.from_local_part}@${process.env.MAIL_DOMAIN ?? 'localhost'}`,
      req.subject ?? '(none)', status, reason, origin,
    ],
  ).catch(() => {});
}

/**
 * Retry messages parked by a failed send.
 *
 * Called opportunistically, unawaited, by inbound requests — so ordinary
 * traffic is what drives recovery. There is no scheduler and nothing to
 * configure. A backlog only persists if the gateway is receiving no traffic at
 * all, in which case nobody is waiting on it either.
 */
export async function retryParked(limit = 5): Promise<number> {
  const due = await query<MessageRow>(
    `UPDATE messages SET status='sending', retry_after=NULL
      WHERE id IN (
        SELECT id FROM messages
         WHERE status='failed' AND attempts < 6
           AND retry_after IS NOT NULL AND retry_after <= NOW()
         ORDER BY created_at LIMIT $1
         FOR UPDATE SKIP LOCKED
      )
     RETURNING *`,
    [limit],
  );

  let sent = 0;
  for (const row of due) {
    const project = await one<ProjectRow>(`SELECT * FROM projects WHERE id=$1`, [row.project_id]);
    if (!project) continue;
    const attachments = await query<{ filename: string; content_type: string; content_b64: string | null; remote_url: string | null }>(
      `SELECT filename, content_type, content_b64, remote_url FROM message_attachments
        WHERE message_id=$1 AND purged_at IS NULL`, [row.id],
    );
    const res = await deliver(
      row,
      attachments.map((a) => ({
        filename: a.filename, content_type: a.content_type,
        ...(a.remote_url ? { url: a.remote_url } : { content: a.content_b64 ?? '' }),
      })),
      row.transport,
      project,
    );
    if (res.status === 'sent') sent++;
  }
  return sent;
}

let lastSweep = 0;

/** Fire-and-forget recovery, rate-limited so it cannot pile up. */
export function maybeRetry(): void {
  const now = Date.now();
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  retryParked().catch(() => {});
}
