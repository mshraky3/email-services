import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema, one, query } from '@/lib/db.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v1/messages/:id — status of one message, scoped to the calling project. */
export const GET = guard(async (req: Request, { params }: { params: { id: string } }) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  // Scoped by project_id so one project's key cannot read another's mail log.
  const message = await one(
    `SELECT id, event_type, priority, audience, to_address, subject, status, status_reason,
            transport, provider_id, attempts, last_error, batch_id, source_origin,
            scheduled_at, expires_at, sent_at, created_at
       FROM messages WHERE id = $1 AND project_id = $2`,
    [params.id, auth.project.id],
  );
  if (!message) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });

  const events = await query(
    `SELECT event_type, bounce_type, occurred_at FROM message_events
      WHERE message_id = $1 ORDER BY occurred_at ASC`,
    [params.id],
  );

  return NextResponse.json({ ok: true, message, events });
});
