import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { maybeRetry, send, type SendRequest } from '@/lib/send.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/**
 * POST /api/v1/notify — structured events, mostly owner-facing alerts.
 *
 * You send fields rather than HTML and the gateway renders them, so a project
 * never has to write email markup. Otherwise identical to /send: it goes out
 * immediately.
 *
 * `dedupeKey` is the useful part here. Give an error alert a stable key and
 * the event's cooldown swallows identical repeats, so one broken endpoint
 * produces one email rather than forty-seven.
 */
export const POST = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  let body: {
    event: string;
    to: string;
    title?: string;
    summary?: string;
    severity?: string;
    fields?: Array<{ label: string; value: string }>;
    link?: { label: string; url: string };
    dir?: 'rtl' | 'ltr';
    dedupeKey?: string;
    sourceOrigin?: string;
    idempotencyKey?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body.event) return NextResponse.json({ ok: false, error: '`event` is required' }, { status: 400 });
  if (!body.title) return NextResponse.json({ ok: false, error: '`title` is required' }, { status: 400 });

  const lines = [body.summary, ...(body.fields ?? []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean);

  const request: SendRequest = {
    event: body.event,
    to: body.to,
    subject: body.title,
    template: 'notice',
    data: { heading: body.title, body: lines.join('\n'), link: body.link },
    severity: body.severity,
    dir: body.dir,
    dedupeKey: body.dedupeKey,
    sourceOrigin: body.sourceOrigin ?? req.headers.get('x-source-origin') ?? req.headers.get('origin') ?? undefined,
    idempotencyKey: body.idempotencyKey ?? req.headers.get('idempotency-key') ?? undefined,
  };

  const result = await send(auth.project, request);
  maybeRetry();

  if (result.status === 'error') {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.http });
  }
  if (result.status === 'failed') {
    return NextResponse.json({ ok: false, ...result }, { status: 502 });
  }
  return NextResponse.json({ ok: true, ...result }, { status: 200 });
});
