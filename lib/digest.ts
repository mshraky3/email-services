/**
 * Digest engine — the biggest quota lever in the system.
 *
 * Nearly all owner-facing mail lands in one or two inboxes. Today that is one
 * email per event (~25/day across the projects); after this it is 2 digests
 * per day plus escalations. Combined with routing `audience:'owner'` to Gmail,
 * that traffic stops consuming the Resend budget entirely.
 *
 * `digest_key` is deliberately shared ACROSS projects: `owner:daily` produces
 * ONE 08:00 email containing MEDQIZE contact forms, MEDQIZE suggestions and
 * portfolio resume pings. Three projects, one email.
 */

import { query, one } from './db.ts';
import { digestTemplate, type DigestGroup } from './render.ts';
import type { DigestItem, PolicyRow, Severity } from './types.ts';
import type { Priority } from './quota.ts';

export type DigestWindow = 'hourly' | 'daily' | 'weekly';

/** Riyadh is UTC+3 with no DST, so a fixed offset is exact rather than approximate. */
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Daily digests flush at these Riyadh hours. */
const DAILY_FLUSH_HOURS = [7, 19];

/**
 * Compute the buffering window an event falls into.
 *
 * Daily windows are NOT midnight-to-midnight — they run between the two flush
 * times, so an event at 20:00 waits for the 07:00 send rather than sitting for
 * a whole day.
 */
export function windowFor(mode: DigestWindow, now: Date): { start: Date; end: Date } {
  if (mode === 'hourly') {
    const start = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    return { start, end: new Date(start.getTime() + 3_600_000) };
  }

  if (mode === 'weekly') {
    const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
    const dow = local.getUTCDay();
    const start = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - dow, 0, 0, 0) - RIYADH_OFFSET_MS);
    return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
  }

  // daily
  const local = new Date(now.getTime() + RIYADH_OFFSET_MS);
  const hour = local.getUTCHours();
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());

  const boundaries = DAILY_FLUSH_HOURS.map((h) => midnightLocal + h * 3_600_000);
  let startLocal = boundaries[boundaries.length - 1] - 86_400_000; // yesterday's last flush
  let endLocal = boundaries[0];
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i];
    if (hour >= DAILY_FLUSH_HOURS[i]) {
      startLocal = b;
      endLocal = i + 1 < boundaries.length ? boundaries[i + 1] : boundaries[0] + 86_400_000;
    }
  }
  return {
    start: new Date(startLocal - RIYADH_OFFSET_MS),
    end: new Date(endLocal - RIYADH_OFFSET_MS),
  };
}

/** Render `{{a.b}}` placeholders against the event payload. */
export function renderTemplate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], ctx);
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Does this event bypass the buffer?
 *
 * The predicate is a plain "field must be one of these values" match, kept
 * deliberately simple so a policy row stays readable in the dashboard.
 */
export function shouldEscalate(policy: Pick<PolicyRow, 'escalate_when'>, ctx: Record<string, unknown>): boolean {
  const rule = policy.escalate_when;
  if (!rule || typeof rule !== 'object') return false;

  return Object.entries(rule).every(([field, expected]) => {
    const actual = field.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], ctx);
    const wanted = Array.isArray(expected) ? expected : [expected];
    return wanted.some((w) => String(w).toLowerCase() === String(actual).toLowerCase());
  });
}

export interface BufferInput {
  projectId: number;
  digestKey: string;
  toAddress: string;
  dedupeKey: string;
  priority: Priority;
  severity: Severity;
  item: DigestItem;
  mode: DigestWindow;
  now?: Date;
}

export interface BufferResult {
  status: 'buffered';
  digest_key: string;
  flush_at: string;
  occurrences: number;
}

/**
 * Add an event to a buffer.
 *
 * A repeat of the same `dedupe_key` inside an open window INCREMENTS rather
 * than inserting. This generalizes MEDQIZE's 5-minute per-error-key cooldown
 * and is strictly better: instead of silently discarding 46 repeats, the digest
 * reports "DB connection refused x47".
 */
export async function buffer(input: BufferInput): Promise<BufferResult> {
  const now = input.now ?? new Date();
  const { start, end } = windowFor(input.mode, now);

  const row = await one<{ occurrences: number }>(
    `INSERT INTO digest_buffer
       (project_id, digest_key, to_address, window_start, window_end,
        dedupe_key, priority, severity, payload, occurrences)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)
     ON CONFLICT (digest_key, lower(to_address), window_start, dedupe_key) WHERE status = 'buffered'
     DO UPDATE SET occurrences  = digest_buffer.occurrences + 1,
                   last_seen_at = NOW(),
                   payload      = EXCLUDED.payload,
                   severity     = EXCLUDED.severity
     RETURNING occurrences`,
    [
      input.projectId, input.digestKey, input.toAddress, start, end,
      input.dedupeKey, input.priority, input.severity, JSON.stringify(input.item),
    ],
  );

  return {
    status: 'buffered',
    digest_key: input.digestKey,
    flush_at: end.toISOString(),
    occurrences: row?.occurrences ?? 1,
  };
}

interface DueBuffer {
  digest_key: string;
  to_address: string;
  window_start: Date;
  total: string;
  threshold: number;
  window_end: Date;
}

/**
 * Buffers ready to send: either the window closed, or enough has piled up that
 * waiting is itself the wrong answer. A hundred errors in ten minutes IS the
 * alert — holding it for another fifty minutes helps nobody.
 */
async function findDue(now: Date): Promise<DueBuffer[]> {
  // The buffer is aggregated BEFORE the threshold is looked up, deliberately.
  //
  // Joining notification_policies directly to digest_buffer multiplies rows:
  // nine MEDQIZE events share digest_key 'owner:daily', so every buffered row
  // would match nine policy rows and SUM(occurrences) would come out 9x too
  // large — firing the volume trigger after 3 real events instead of 25.
  // Aggregating first, then joining a pre-reduced threshold table, keeps the
  // count honest.
  return query<DueBuffer>(
    `WITH agg AS (
       SELECT digest_key,
              MIN(to_address)    AS to_address,
              window_start,
              MIN(window_end)    AS window_end,
              SUM(occurrences)::int AS total
         FROM digest_buffer
        WHERE status = 'buffered'
        GROUP BY digest_key, lower(to_address), window_start
     ),
     thr AS (
       SELECT digest_key_template AS digest_key, MIN(flush_threshold) AS threshold
         FROM notification_policies
        WHERE digest_key_template IS NOT NULL
        GROUP BY digest_key_template
     )
     SELECT a.digest_key, a.to_address, a.window_start, a.window_end,
            a.total::text AS total,
            COALESCE(t.threshold, 25) AS threshold
       FROM agg a
       LEFT JOIN thr t ON t.digest_key = a.digest_key
      WHERE a.window_end <= $1
         OR a.total >= COALESCE(t.threshold, 25)`,
    [now],
  );
}

export interface FlushDeps {
  /** Enqueue the rendered digest as a real message. Injected to avoid a cycle with ingest. */
  enqueueDigest: (args: {
    projectId: number;
    toAddress: string;
    subject: string;
    html: string;
    text: string;
    digestKey: string;
    flushBatch: string;
  }) => Promise<string>;
}

/**
 * Flush one buffer.
 *
 * The set is FROZEN first (status -> 'flushing' with a batch id), exactly like
 * the frozen recipient list in MEDQIZE's broadcast module. Anything arriving
 * between the freeze and the send lands in the next window instead of being
 * lost or double-counted.
 */
export async function flushOne(
  key: { digestKey: string; toAddress: string; windowStart: Date },
  deps: FlushDeps,
): Promise<boolean> {
  const batch = crypto.randomUUID();

  const frozen = await query<{
    project_id: number; slug: string; display_name: string;
    severity: Severity; payload: DigestItem; occurrences: number; dedupe_key: string;
  }>(
    `WITH frozen AS (
       UPDATE digest_buffer
          -- last_seen_at is restamped so it marks the FREEZE time, which is
          -- what reclaimStrandedFlushes() measures staleness against. Without
          -- this it would still hold the original buffering time and could
          -- un-freeze a flush that is actively in progress.
          SET status = 'flushing', flush_batch = $4, last_seen_at = NOW()
        WHERE digest_key = $1 AND lower(to_address) = lower($2)
          AND window_start = $3 AND status = 'buffered'
        RETURNING *
     )
     SELECT f.project_id, p.slug, p.display_name, f.severity, f.payload, f.occurrences, f.dedupe_key
       FROM frozen f JOIN projects p ON p.id = f.project_id
      ORDER BY p.display_name, f.created_at`,
    [key.digestKey, key.toAddress, key.windowStart, batch],
  );

  if (frozen.length === 0) return false;

  const byProject = new Map<string, DigestGroup>();
  for (const row of frozen) {
    if (!byProject.has(row.slug)) byProject.set(row.slug, { project: row.display_name, items: [] });
    byProject.get(row.slug)!.items.push({
      item: row.payload,
      occurrences: row.occurrences,
      severity: row.severity,
      eventType: row.dedupe_key,
    });
  }

  const groups = [...byProject.values()];
  const rendered = digestTemplate(groups, { date: new Date().toISOString().slice(0, 10) });

  const messageId = await deps.enqueueDigest({
    projectId: frozen[0].project_id,
    toAddress: key.toAddress,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    digestKey: key.digestKey,
    flushBatch: batch,
  });

  await query(
    `UPDATE digest_buffer SET status='flushed', message_id=$2 WHERE flush_batch = $1`,
    [batch, messageId],
  );
  return true;
}

/**
 * Recover buffers stranded mid-flush.
 *
 * `flushOne` freezes rows to 'flushing' and only marks them 'flushed' once the
 * digest message exists. If the process dies in between — and on Vercel it can,
 * because a lambda is frozen the moment it returns a response — those rows are
 * invisible forever: `findDue` only ever looks at 'buffered'. That is silent,
 * permanent mail loss, and it was observed on the live deployment.
 *
 * Reverting them to 'buffered' is safe. The freeze is the only thing that
 * happened; nothing was sent, so nothing can be double-sent. Worst case the
 * events land in a later digest.
 */
export async function reclaimStrandedFlushes(staleMinutes = 5): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE digest_buffer
        SET status = 'buffered', flush_batch = NULL
      WHERE status = 'flushing'
        AND message_id IS NULL
        AND last_seen_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id::text AS id`,
    [String(staleMinutes)],
  );
  return rows.length;
}

/** Flush everything due. Returns how many digest emails were produced. */
export async function flushDue(deps: FlushDeps, now = new Date()): Promise<number> {
  // Recover anything a previous interrupted run left frozen, before deciding
  // what is due — otherwise those events would never be seen again.
  await reclaimStrandedFlushes();

  const due = await findDue(now);
  let sent = 0;
  for (const d of due) {
    const ok = await flushOne(
      { digestKey: d.digest_key, toAddress: d.to_address, windowStart: d.window_start },
      deps,
    );
    if (ok) sent++;
  }
  return sent;
}

/**
 * Force a buffer out early because something urgent just happened, so the
 * alarm arrives with its context rather than an hour ahead of it.
 */
export async function forceFlush(digestKey: string, toAddress: string, deps: FlushDeps): Promise<number> {
  const open = await query<{ window_start: Date }>(
    `SELECT DISTINCT window_start FROM digest_buffer
      WHERE digest_key = $1 AND lower(to_address) = lower($2) AND status = 'buffered'`,
    [digestKey, toAddress],
  );
  let n = 0;
  for (const row of open) {
    if (await flushOne({ digestKey, toAddress, windowStart: row.window_start }, deps)) n++;
  }
  return n;
}
