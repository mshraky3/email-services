import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { maybeRetry, send, type SendRequest } from '@/lib/send.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_RECIPIENTS = 500;

/** Resend allows ~10 req/s; this stays comfortably under it. */
const PER_SEND_DELAY_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/v1/send/bulk — one payload, many recipients.
 *
 * Exists for HR-'s fan-out ("notify all branches"), which used to send N
 * emails inline from one request handler and time out. Here the sends are
 * paced and the response reports exactly what happened to each recipient.
 *
 * Still synchronous — there is no queue to hand off to. Sending is capped at
 * MAX_RECIPIENTS and paced, so a very large audience should be split by the
 * caller rather than parked somewhere invisible.
 */
export const POST = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: SendRequest & {
    recipients?: Array<string | { to: string; toName?: string; data?: Record<string, unknown> }>;
  };
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
      { ok: false, error: `too many recipients (max ${MAX_RECIPIENTS}) — split the batch` },
      { status: 413 },
    );
  }

  body.sourceOrigin ??= req.headers.get('x-source-origin') ?? req.headers.get('origin') ?? undefined;

  const batch = crypto.randomUUID();
  const seen = new Set<string>();
  const tally = { sent: 0, failed: 0, duplicate: 0, suppressed: 0, dropped: 0, throttled: 0, invalid: 0 };
  const failures: Array<{ to: string; error: string }> = [];

  for (const entry of recipients) {
    const to = typeof entry === 'string' ? entry : entry.to;
    if (!to) { tally.invalid++; continue; }

    // The same person appearing twice in an audience must not be mailed twice.
    const key = to.toLowerCase();
    if (seen.has(key)) { tally.duplicate++; continue; }
    seen.add(key);

    const per: SendRequest = {
      ...body,
      to,
      toName: typeof entry === 'string' ? undefined : entry.toName,
      data: typeof entry === 'string' ? body.data : { ...body.data, ...entry.data },
      // Per-recipient, so a retried batch cannot double-send.
      idempotencyKey: body.idempotencyKey ? `${body.idempotencyKey}:${key}` : `${batch}:${key}`,
    };

    const r = await send(auth.project, per);
    switch (r.status) {
      case 'sent': tally.sent++; break;
      case 'failed': tally.failed++; failures.push({ to, error: r.error }); break;
      case 'duplicate': tally.duplicate++; break;
      case 'suppressed': tally.suppressed++; break;
      case 'dropped': tally.dropped++; break;
      case 'throttled': tally.throttled++; break;
      case 'error': tally.invalid++; break;
    }

    await sleep(PER_SEND_DELAY_MS);
  }

  maybeRetry();

  return NextResponse.json({
    ok: tally.failed === 0,
    batch_id: batch,
    recipients: recipients.length,
    ...tally,
    // Failed sends are parked and retried by later traffic, so this is a
    // report rather than a loss.
    failures: failures.slice(0, 20),
  });
});
