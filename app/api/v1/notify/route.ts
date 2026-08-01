import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { flushDeps, ingest, type SendRequest } from '@/lib/ingest.ts';
import { flushDue } from '@/lib/digest.ts';
import { maybeDrain } from '@/lib/queue.ts';
import { normalizeSeverity, type DigestItem } from '@/lib/types.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/notify — Tier B, structured events.
 *
 * The caller sends structure, not HTML, because the gateway may need to MERGE
 * this event with others into a digest. You cannot merge pre-rendered HTML
 * bodies, which is the whole reason this endpoint exists alongside /send.
 *
 * Use it for anything owner-facing. Use /send for user-facing mail whose
 * template already exists in the project.
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
    /** Accepts the caller's own scale (CRITICAL/HIGH/MEDIUM/LOW) — normalized below. */
    severity?: string;
    fields?: Array<{ label: string; value: string }>;
    link?: { label: string; url: string };
    dir?: 'rtl' | 'ltr';
    dedupeKey?: string;
    data?: Record<string, unknown>;
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

  const item: DigestItem = {
    title: body.title,
    summary: body.summary,
    severity: normalizeSeverity(body.severity),
    dir: body.dir ?? auth.project.default_dir,
    occurred_at: new Date().toISOString(),
    fields: body.fields,
    link: body.link,
  };

  const request: SendRequest = {
    event: body.event,
    to: body.to,
    subject: body.title,
    text: [body.summary, ...(body.fields ?? []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
    severity: body.severity ?? 'info',
    dir: body.dir,
    item,
    dedupeKey: body.dedupeKey,
    data: body.data,
    sourceOrigin: body.sourceOrigin ?? req.headers.get('x-source-origin') ?? req.headers.get('origin') ?? undefined,
    idempotencyKey: body.idempotencyKey ?? req.headers.get('idempotency-key') ?? undefined,
  };

  // A structured event with no pre-rendered HTML that turns out NOT to be
  // digestible still has to become a real email — render it through the
  // central `notice` template rather than sending an empty body.
  if (!request.html) {
    request.template = 'notice';
    request.data = {
      heading: body.title,
      body: [body.summary, ...(body.fields ?? []).map((f) => `${f.label}: ${f.value}`)].filter(Boolean).join('\n'),
      link: body.link,
      ...body.data,
    };
  }

  const result = await ingest(auth.project, request);
  maybeDrain(() => flushDue(flushDeps));

  if (result.status === 'error') {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.http });
  }
  return NextResponse.json({ ok: true, ...result }, { status: result.status === 'queued' ? 202 : 200 });
});
