/**
 * The queue: claiming, pacing, retrying, draining.
 *
 * Generalized from MEDQIZE's backend/routes/admin-broadcast.js, which is the
 * proven reference implementation — frozen recipient lists, FOR UPDATE SKIP
 * LOCKED claiming, stuck-row reclaim, and a rolling 24h cap. Those mechanisms
 * are kept; what changes is that they now serve every project and every
 * priority instead of one broadcast feature.
 */

import { query, one, tx, withAdvisoryLock } from './db.ts';
import {
  admit,
  type ClassPolicy,
  type Priority,
  type ProjectLimits,
  type QuotaSnapshot,
} from './quota.ts';
import { checkSuppressed } from './suppression.ts';
import { countsAgainstQuota, pickTransport, transports, type OutboundMessage } from './transports/index.ts';
import { TransportError, type Attachment, type MessageRow, type TransportName } from './types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── settings ────────────────────────────────────────────────────────────────

export interface Settings {
  dailyCeiling: number;
  monthlyCeiling: number;
  burstMultiplier: number;
  perSendDelayMs: number;
  drainBatchSize: number;
  stuckReclaimMin: number;
}

export async function loadSettings(): Promise<Settings> {
  const rows = await query<{ k: string; v: string }>(`SELECT k, v FROM quota_settings`);
  const map = new Map(rows.map((r) => [r.k, r.v]));
  const num = (k: string, d: number) => Number(map.get(k) ?? d);
  return {
    dailyCeiling: num('daily_ceiling', 95),
    monthlyCeiling: num('monthly_ceiling', 2900),
    burstMultiplier: num('burst_multiplier', 1.25),
    perSendDelayMs: num('per_send_delay_ms', 600),
    drainBatchSize: num('drain_batch_size', 5),
    stuckReclaimMin: num('stuck_reclaim_min', 5),
  };
}

export async function loadPolicies(): Promise<ClassPolicy[]> {
  const rows = await query<{
    priority: number; name: string; reserve: number; ceiling: number;
    ttl_seconds: number; on_expiry: 'dead' | 'drop' | 'fold';
  }>(`SELECT * FROM quota_policy ORDER BY priority`);
  return rows.map((r) => ({
    priority: r.priority as Priority,
    name: r.name,
    reserve: r.reserve,
    ceiling: r.ceiling,
    ttlSeconds: r.ttl_seconds,
    onExpiry: r.on_expiry,
  }));
}

/**
 * Read current consumption.
 *
 * Rolling 24h, and `attempting` counts alongside `sent`: a request that timed
 * out after Resend accepted it consumed provider quota we will never see
 * acknowledged. Counting only confirmed sends is how you silently exceed 100.
 */
export async function loadQuotaSnapshot(): Promise<QuotaSnapshot> {
  const [settings, policies] = await Promise.all([loadSettings(), loadPolicies()]);

  const daily = await query<{ priority: number; used: string }>(
    `SELECT priority, COUNT(*)::text AS used
       FROM messages
      WHERE transport = 'resend'
        AND status IN ('sent','attempting')
        AND COALESCE(sent_at, claimed_at) > NOW() - INTERVAL '24 hours'
      GROUP BY priority`,
  );
  const usedByPriority = [0, 0, 0, 0, 0];
  for (const r of daily) usedByPriority[r.priority] = Number(r.used);

  const monthly = await one<{ used: string }>(
    `SELECT COUNT(*)::text AS used
       FROM messages
      WHERE transport = 'resend'
        AND status IN ('sent','attempting')
        AND sent_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
  );

  return {
    dailyCeiling: settings.dailyCeiling,
    monthlyCeiling: settings.monthlyCeiling,
    burstMultiplier: settings.burstMultiplier,
    usedByPriority,
    monthUsed: Number(monthly?.used ?? 0),
    policies,
    now: new Date(),
  };
}

export async function loadProjectLimits(projectId: number): Promise<ProjectLimits> {
  const row = await one<{
    slug: string; daily_max: number; monthly_max: number; today: string; month: string;
  }>(
    `SELECT p.slug, p.daily_max, p.monthly_max,
            (SELECT COUNT(*)::text FROM messages m
              WHERE m.project_id = p.id AND m.transport = 'resend'
                AND m.status IN ('sent','attempting')
                AND COALESCE(m.sent_at, m.claimed_at) > NOW() - INTERVAL '24 hours') AS today,
            (SELECT COUNT(*)::text FROM messages m
              WHERE m.project_id = p.id AND m.transport = 'resend'
                AND m.status IN ('sent','attempting')
                AND m.sent_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')) AS month
       FROM projects p WHERE p.id = $1`,
    [projectId],
  );
  if (!row) throw new Error(`Unknown project ${projectId}`);
  return {
    slug: row.slug,
    dailyMax: row.daily_max,
    monthlyMax: row.monthly_max,
    usedToday: Number(row.today),
    usedThisMonth: Number(row.month),
  };
}

// ── claiming ────────────────────────────────────────────────────────────────

/**
 * Claim up to `limit` due messages.
 *
 * `FOR UPDATE SKIP LOCKED` means two overlapping drainers can never claim the
 * same row. `ROW_NUMBER() PARTITION BY project_id` interleaves projects inside
 * a priority band, so one project's backlog cannot monopolise a tick.
 *
 * Rows stuck in `claimed`/`attempting` past the reclaim window are treated as a
 * killed batch and retried. That is only safe because every send carries a
 * stable Idempotency-Key derived from the message id — without it, this reclaim
 * would itself be a double-send generator.
 */
export async function claim(limit: number, stuckReclaimMin: number): Promise<MessageRow[]> {
  if (limit <= 0) return [];
  return query<MessageRow>(
    `WITH candidates AS (
       SELECT m.id, m.priority, m.scheduled_at, m.created_at,
              ROW_NUMBER() OVER (PARTITION BY m.project_id
                ORDER BY m.priority ASC, m.scheduled_at ASC, m.created_at ASC) AS rn
         FROM messages m
         JOIN projects p ON p.id = m.project_id
        WHERE p.active
          AND m.scheduled_at <= NOW()
          AND m.expires_at > NOW()
          AND ( m.status = 'queued'
             OR (m.status IN ('claimed','attempting')
                 AND m.claimed_at < NOW() - ($2 || ' minutes')::interval) )
     ),
     picked AS (
       SELECT id FROM candidates
        ORDER BY priority ASC, rn ASC, created_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE messages m
        SET status = 'claimed', claimed_at = NOW(), updated_at = NOW()
       FROM picked
      WHERE m.id = picked.id
     RETURNING m.*`,
    [limit, String(stuckReclaimMin)],
  );
}

export async function loadAttachments(messageId: string): Promise<Attachment[]> {
  const rows = await query<{ filename: string; content_type: string; content_b64: string | null; remote_url: string | null }>(
    `SELECT filename, content_type, content_b64, remote_url
       FROM message_attachments WHERE message_id = $1 AND purged_at IS NULL`,
    [messageId],
  );
  return rows.map((r) => ({
    filename: r.filename,
    content_type: r.content_type,
    ...(r.remote_url ? { url: r.remote_url } : { content: r.content_b64 ?? '' }),
  }));
}

// ── state transitions ───────────────────────────────────────────────────────

async function markAttempting(id: string, transport: TransportName): Promise<void> {
  await query(
    `UPDATE messages
        SET status='attempting', transport=$2, attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1`,
    [id, transport],
  );
}

async function markSent(id: string, providerId: string | null): Promise<void> {
  await query(
    `UPDATE messages SET status='sent', provider_id=$2, sent_at=NOW(), updated_at=NOW(), last_error=NULL
      WHERE id = $1`,
    [id, providerId],
  );
}

async function markTerminal(id: string, status: 'failed' | 'dead' | 'suppressed' | 'expired' | 'dropped', reason: string): Promise<void> {
  await query(
    `UPDATE messages SET status=$2, status_reason=$3, last_error=$3, updated_at=NOW() WHERE id = $1`,
    [id, status, reason.slice(0, 500)],
  );
}

/** Put a message back in the queue at a later time without burning an attempt. */
async function defer(id: string, seconds: number, reason: string): Promise<void> {
  await query(
    `UPDATE messages
        SET status='queued',
            claimed_at=NULL,
            attempts = GREATEST(0, attempts - 1),
            scheduled_at = NOW() + ($2 || ' seconds')::interval,
            status_reason = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [id, String(Math.max(1, Math.round(seconds))), reason.slice(0, 500)],
  );
}

const MAX_ATTEMPTS = 5;

/** 1m, 2m, 4m, 8m, 16m capped at 1h, with +/-20% jitter to avoid lockstep retries. */
function backoffSeconds(attempt: number): number {
  const base = Math.min(60 * 2 ** attempt, 3600);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

async function handleFailure(msg: MessageRow, err: unknown): Promise<'retry' | 'dead' | 'quota'> {
  const te = err instanceof TransportError ? err : new TransportError('server', String((err as Error)?.message ?? err));

  // The provider says the budget is gone. That is not this message's fault —
  // defer it without consuming an attempt and let the circuit breaker stop the
  // rest of the batch.
  if (te.kind === 'quota') {
    await defer(msg.id, te.retryAfterSeconds ?? 1800, `provider quota exhausted: ${te.message}`);
    return 'quota';
  }

  if (!te.retryable || msg.attempts >= MAX_ATTEMPTS) {
    await markTerminal(msg.id, msg.attempts >= MAX_ATTEMPTS ? 'dead' : 'failed', te.message);
    return 'dead';
  }

  await query(
    `UPDATE messages
        SET status='queued', claimed_at=NULL, last_error=$2,
            scheduled_at = NOW() + ($3 || ' seconds')::interval, updated_at=NOW()
      WHERE id = $1`,
    [msg.id, te.message.slice(0, 500), String(te.retryAfterSeconds ?? backoffSeconds(msg.attempts))],
  );
  return 'retry';
}

// ── housekeeping ────────────────────────────────────────────────────────────

/** Apply each class's TTL policy to overdue messages. */
export async function expireOverdue(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE messages m
        SET status = CASE qp.on_expiry WHEN 'dead' THEN 'dead' ELSE 'expired' END,
            status_reason = 'ttl expired (' || qp.on_expiry || ')',
            updated_at = NOW()
       FROM quota_policy qp
      WHERE qp.priority = m.priority
        AND m.status IN ('queued','claimed','attempting')
        AND m.expires_at <= NOW()
      RETURNING m.id`,
  );
  return rows.length;
}

/**
 * Invoices and subscriber reports are PII and must not accumulate in a mail
 * gateway. Drop the bytes 24h after the message reached a terminal state; the
 * row itself stays for the audit trail.
 */
export async function purgeSentAttachments(): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE message_attachments a
        SET content_b64 = NULL, purged_at = NOW()
       FROM messages m
      WHERE m.id = a.message_id
        AND a.purged_at IS NULL
        AND a.content_b64 IS NOT NULL
        AND m.status IN ('sent','dead','failed','expired','suppressed','dropped','cancelled')
        AND m.updated_at < NOW() - INTERVAL '24 hours'
      RETURNING a.id`,
  );
  return rows.length;
}

// ── the drain loop ──────────────────────────────────────────────────────────

export interface DrainResult {
  skipped?: string;
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
  expired: number;
  purged: number;
  digestsFlushed: number;
  quotaCircuitBroken?: boolean;
}

export interface DrainOptions {
  source?: string;
  budgetMs?: number;
  /** Injected to avoid a circular import with lib/digest.ts. */
  flushDigests?: () => Promise<number>;
}

/**
 * One scheduler tick.
 *
 * Held under an advisory lock so only one drainer runs at a time. That is not
 * about correctness of claiming (SKIP LOCKED already handles that) but about
 * the request rate: two concurrent drainers would each pace their own sends and
 * double the effective rate against the provider.
 */
export async function drain(opts: DrainOptions = {}): Promise<DrainResult> {
  const { source = 'cron', budgetMs = 25_000, flushDigests } = opts;

  const outcome = await withAdvisoryLock('email:drain', async (): Promise<DrainResult> => {
    const started = Date.now();
    const settings = await loadSettings();
    const result: DrainResult = {
      claimed: 0, sent: 0, failed: 0, deferred: 0, expired: 0, purged: 0, digestsFlushed: 0,
    };

    const run = await one<{ id: string }>(
      `INSERT INTO drain_runs (source) VALUES ($1) RETURNING id::text AS id`,
      [source],
    );

    try {
      result.expired = await expireOverdue();
      result.purged = await purgeSentAttachments();
      if (flushDigests) result.digestsFlushed = await flushDigests();

      let snapshot = await loadQuotaSnapshot();
      const projectCache = new Map<number, ProjectLimits>();

      while (Date.now() - started < budgetMs) {
        const batch = await claim(settings.drainBatchSize, settings.stuckReclaimMin);
        if (batch.length === 0) break;
        result.claimed += batch.length;

        for (const msg of batch) {
          const project = await (async () => {
            if (!projectCache.has(msg.project_id)) {
              projectCache.set(msg.project_id, await loadProjectLimits(msg.project_id));
            }
            return projectCache.get(msg.project_id)!;
          })();

          const policy = await one<{ honors_unsubscribe: boolean; transport_hint: TransportName | null }>(
            `SELECT honors_unsubscribe, transport_hint FROM notification_policies
              WHERE project_id = $1 AND event_type = $2`,
            [msg.project_id, msg.event_type],
          );

          const suppression = await checkSuppressed(
            msg.to_address, msg.priority, project.slug, policy?.honors_unsubscribe ?? true,
          );
          if (suppression.suppressed) {
            await markTerminal(msg.id, 'suppressed', `suppressed: ${suppression.reason}`);
            continue;
          }

          const projectRow = await one<{ allowed_transports: TransportName[]; dry_run: boolean }>(
            `SELECT allowed_transports, dry_run FROM projects WHERE id = $1`,
            [msg.project_id],
          );

          const verdict = admit(snapshot, msg.priority, project);
          const transport = pickTransport({
            audience: msg.audience,
            priority: msg.priority,
            transportHint: policy?.transport_hint ?? null,
            allowedTransports: projectRow?.allowed_transports ?? ['resend'],
            resendExhausted: !verdict.ok,
            dryRun: process.env.DRY_RUN === 'true' || Boolean(projectRow?.dry_run),
          });

          // Only rationed transports consult the budget. Gmail and dry-run
          // sends bypass it entirely — that is the whole point of routing
          // owner mail off Resend.
          if (countsAgainstQuota(transport) && !verdict.ok) {
            await defer(msg.id, msg.priority <= 1 ? 120 : 3600, `quota: ${verdict.reason}`);
            result.deferred++;
            continue;
          }

          const outbound: OutboundMessage = {
            from: `"${msg.from_name}" <${msg.from_address}>`,
            to: msg.to_address,
            replyTo: msg.reply_to,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            headers: msg.headers ?? {},
            attachments: await loadAttachments(msg.id),
            // Stable across every retry of this message. This is what makes the
            // stuck-row reclaim above safe rather than a double-send bug.
            idempotencyKey: msg.id,
          };

          // Reserve the slot BEFORE the call. If the request times out after the
          // provider accepted it, the quota was spent whether we hear back or not.
          if (countsAgainstQuota(transport)) {
            snapshot.usedByPriority[msg.priority]++;
            snapshot.monthUsed++;
            projectCache.set(msg.project_id, { ...project, usedToday: project.usedToday + 1, usedThisMonth: project.usedThisMonth + 1 });
          }
          await markAttempting(msg.id, transport);

          try {
            const res = await transports[transport](outbound);
            await markSent(msg.id, res.id);
            result.sent++;
          } catch (err) {
            const disposition = await handleFailure(msg, err);
            if (disposition === 'quota') {
              // Authoritative provider-side exhaustion. Stop the whole tick —
              // every further send would 429 too.
              result.deferred++;
              result.quotaCircuitBroken = true;
              return result;
            }
            result.failed++;
            // A definite 4xx never consumed provider quota, so give the slot back.
            if (err instanceof TransportError && err.kind === 'validation' && countsAgainstQuota(transport)) {
              snapshot.usedByPriority[msg.priority] = Math.max(0, snapshot.usedByPriority[msg.priority] - 1);
              snapshot.monthUsed = Math.max(0, snapshot.monthUsed - 1);
            }
          }

          await sleep(settings.perSendDelayMs);
        }

        snapshot = await loadQuotaSnapshot();
      }

      return result;
    } finally {
      if (run?.id) {
        await query(
          `UPDATE drain_runs SET finished_at=NOW(), claimed=$1, sent=$2, failed=$3, deferred=$4 WHERE id = $5::bigint`,
          [result.claimed, result.sent, result.failed, result.deferred, run.id],
        ).catch(() => {});
      }
    }
  });

  if (!outcome.acquired) {
    return { skipped: 'locked', claimed: 0, sent: 0, failed: 0, deferred: 0, expired: 0, purged: 0, digestsFlushed: 0 };
  }
  return outcome.result;
}

// ── opportunistic draining ──────────────────────────────────────────────────

let lastOpportunistic = 0;

/**
 * Fired (unawaited) by inbound API calls.
 *
 * Vercel Hobby crons cannot run more than once a day, so a queue that only
 * moved on cron would be useless. Any traffic at all now keeps it draining, and
 * the external scheduler becomes a floor rather than the only mechanism.
 */
export function maybeDrain(flushDigests?: () => Promise<number>): void {
  const now = Date.now();
  if (now - lastOpportunistic < 20_000) return;
  lastOpportunistic = now;
  drain({ source: 'opportunistic', budgetMs: 8_000, flushDigests }).catch(() => {});
}

export { tx };
