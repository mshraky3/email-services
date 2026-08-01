import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { flushDeps, ingest, type SendRequest } from '@/lib/ingest.ts';
import { flushDue } from '@/lib/digest.ts';
import { maybeDrain } from '@/lib/queue.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/send — Tier A passthrough.
 *
 * The response distinguishes SUCCESS-BUT-NOT-SENT (`suppressed`, `buffered`,
 * `dropped`, `duplicate`) from genuine failures. That distinction is what makes
 * the client SDK's fallback safe: a caller must never retry or fall back to its
 * own SMTP on those, because the gateway handled them correctly.
 */
export const POST = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

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

  const result = await ingest(auth.project, body);

  // Vercel Hobby crons cannot run more than daily, so inbound traffic is the
  // main thing keeping the queue moving.
  maybeDrain(() => flushDue(flushDeps));

  switch (result.status) {
    case 'sent':
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    case 'queued':
      return NextResponse.json({ ok: true, ...result }, { status: 202 });
    case 'buffered':
    case 'suppressed':
    case 'dropped':
    case 'duplicate':
      return NextResponse.json({ ok: true, ...result }, { status: 200 });
    case 'error':
      return NextResponse.json(
        { ok: false, error: result.error, ...(result.retry_after ? { retry_after: result.retry_after } : {}) },
        { status: result.http, ...(result.retry_after ? { headers: { 'Retry-After': String(result.retry_after) } } : {}) },
      );
  }
});
