import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema, one } from '@/lib/db.ts';
import { flushDeps, ingest, type SendRequest } from '@/lib/ingest.ts';
import { flushDue } from '@/lib/digest.ts';
import { loadProjectLimits, loadQuotaSnapshot, maybeDrain } from '@/lib/queue.ts';
import { admit, type Priority } from '@/lib/quota.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_RECIPIENTS = 2000;

/**
 * POST /api/v1/send/bulk — one payload, many recipients.
 *
 * This exists because of HR-'s six fan-out loops: "notify all branches" is the
 * product's core feature and currently sends N emails inline inside a single
 * HTTP request on a 60-second Vercel budget, which times out and leaves no
 * record of how far it got.
 *
 * Here it returns 202 immediately with an honest schedule. The caller gets a
 * fast, truthful answer ("100 recipients, 40 today, the rest over 2 days")
 * instead of a 500.
 */
export const POST = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: SendRequest & { recipients?: Array<string | { to: string; toName?: string; data?: Record<string, unknown> }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  const recipients = body.recipients ?? [];
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return NextResponse.json({ ok: false, error: '`recipients` must be a non-empty array' }, { status: 400 });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      { ok: false, error: `too many recipients (max ${MAX_RECIPIENTS})` },
      { status: 413 },
    );
  }

  body.sourceOrigin ??= req.headers.get('x-source-origin') ?? req.headers.get('origin') ?? undefined;

  const batchId = crypto.randomUUID();
  const seen = new Set<string>();
  const results = { accepted: 0, duplicate: 0, suppressed: 0, dropped: 0, failed: 0 };

  for (const entry of recipients) {
    const to = typeof entry === 'string' ? entry : entry.to;
    if (!to) continue;

    // Deduplicate inside the batch. MEDQIZE's broadcast module learned this the
    // hard way with DISTINCT ON (LOWER(email)) — the same person appearing
    // twice in an audience must not be mailed twice.
    const key = to.toLowerCase();
    if (seen.has(key)) { results.duplicate++; continue; }
    seen.add(key);

    const per: SendRequest = {
      ...body,
      to,
      toName: typeof entry === 'string' ? undefined : entry.toName,
      data: typeof entry === 'string' ? body.data : { ...body.data, ...entry.data },
      // Per-recipient idempotency so a retried batch cannot double-send.
      idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:${key}` : `${batchId}:${key}`,
    };

    const outcome = await ingest(auth.project, per);
    switch (outcome.status) {
      case 'queued': case 'sent': case 'buffered': results.accepted++; break;
      case 'duplicate': results.duplicate++; break;
      case 'suppressed': results.suppressed++; break;
      case 'dropped': results.dropped++; break;
      case 'error': results.failed++; break;
    }
  }

  await one(`UPDATE messages SET batch_id = $1 WHERE idempotency_key LIKE $2 AND batch_id IS NULL`, [
    batchId, `${batchId}:%`,
  ]).catch(() => {});

  // Tell the caller honestly how long this will take rather than pretending it
  // all goes out now.
  const [snapshot, limits] = await Promise.all([loadQuotaSnapshot(), loadProjectLimits(auth.project.id)]);
  const priority = (body.priority ?? 4) as Priority;
  const todayCapacity = admit(snapshot, priority, limits).remaining;
  const days = todayCapacity > 0 ? Math.ceil(results.accepted / Math.max(1, todayCapacity)) : null;

  maybeDrain(() => flushDue(flushDeps));

  return NextResponse.json(
    {
      ok: true,
      batch_id: batchId,
      recipients: recipients.length,
      ...results,
      capacity_today: todayCapacity,
      scheduled_over: days === null ? 'unknown — no capacity right now' : days <= 1 ? 'today' : `${days} days`,
    },
    { status: 202 },
  );
});
