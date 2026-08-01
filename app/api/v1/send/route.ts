import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { maybeRetry, send, type SendRequest } from '@/lib/send.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/v1/send — sends the email, now, and tells you what happened.
 *
 * Synchronous by design. There is no queue: a 200 means it left the building,
 * and the response carries the provider's message id. Nothing to poll.
 *
 * Non-error outcomes that are NOT a send — `suppressed`, `dropped`,
 * `throttled`, `duplicate` — still return 200. They mean the gateway handled
 * the request correctly and the caller must not retry.
 */
export const POST = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: SendRequest;
  try {
    body = (await req.json()) as SendRequest;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  // Let the caller declare its origin, but fall back to the real headers so a
  // project that forgets to pass `sourceOrigin` is still gated.
  body.sourceOrigin ??= req.headers.get('x-source-origin') ?? req.headers.get('origin') ?? req.headers.get('referer') ?? undefined;
  body.idempotencyKey ??= req.headers.get('idempotency-key') ?? undefined;

  const result = await send(auth.project, body);

  // Ordinary traffic is what recovers previously failed sends. No scheduler.
  maybeRetry();

  if (result.status === 'error') {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.http });
  }
  if (result.status === 'failed') {
    // The gateway did not deliver, so the caller may legitimately fall back to
    // its own sender. 502 is outside the SDK's no-fallback list on purpose.
    return NextResponse.json({ ok: false, ...result }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});
