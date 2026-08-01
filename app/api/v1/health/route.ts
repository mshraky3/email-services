import { NextResponse } from 'next/server';
import { ensureSchema, one } from '@/lib/db.ts';
import { loadQuotaSnapshot } from '@/lib/queue.ts';
import { quotaReport } from '@/lib/quota.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health — unauthenticated liveness.
 *
 * `oldest_pending_seconds` is the number that matters: it is how you find out
 * the external scheduler has silently stopped. Point an uptime monitor here.
 */
export async function GET() {
  try {
    await ensureSchema();

    const [queue, snapshot, lastDrain] = await Promise.all([
      one<{ pending: string; oldest: string | null; dead: string; attempting: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('queued','claimed'))::text AS pending,
           COUNT(*) FILTER (WHERE status = 'attempting')::text AS attempting,
           COUNT(*) FILTER (WHERE status = 'dead')::text AS dead,
           EXTRACT(EPOCH FROM (NOW() - MIN(scheduled_at) FILTER (WHERE status IN ('queued','claimed'))))::text AS oldest
         FROM messages`,
      ),
      loadQuotaSnapshot(),
      one<{ started_at: Date; sent: number; source: string }>(
        `SELECT started_at, sent, source FROM drain_runs ORDER BY started_at DESC LIMIT 1`,
      ),
    ]);

    const oldest = Number(queue?.oldest ?? 0);
    const staleQueue = oldest > 3600;

    return NextResponse.json(
      {
        ok: true,
        status: staleQueue ? 'degraded' : 'healthy',
        dry_run: process.env.DRY_RUN === 'true',
        queue: {
          pending: Number(queue?.pending ?? 0),
          attempting: Number(queue?.attempting ?? 0),
          dead: Number(queue?.dead ?? 0),
          oldest_pending_seconds: Math.round(oldest),
        },
        last_drain: lastDrain
          ? { at: lastDrain.started_at, sent: lastDrain.sent, source: lastDrain.source }
          : null,
        quota: quotaReport(snapshot),
      },
      { status: staleQueue ? 503 : 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: 'unhealthy', error: (err as Error).message },
      { status: 503 },
    );
  }
}
