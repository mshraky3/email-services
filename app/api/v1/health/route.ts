import { NextResponse } from 'next/server';
import { ensureSchema, one } from '@/lib/db.ts';
import { DEFAULT_DAILY_BUDGET, quotaReport } from '@/lib/quota.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/health — unauthenticated liveness.
 *
 * With no queue there is no backlog to watch. The one number that can indicate
 * trouble is `awaiting_retry`: sends that failed and are waiting for the next
 * inbound request to pick them up. A handful is normal; a growing pile means
 * a transport is broken.
 */
export async function GET() {
  try {
    await ensureSchema();

    const [stats, budgetRow] = await Promise.all([
      one<{ retrying: string; failed_24h: string; sent_24h: string; oldest: string | null; resend_24h: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE status='failed' AND retry_after IS NOT NULL)::text AS retrying,
           COUNT(*) FILTER (WHERE status='failed' AND created_at > NOW() - INTERVAL '24 hours')::text AS failed_24h,
           COUNT(*) FILTER (WHERE status='sent'   AND created_at > NOW() - INTERVAL '24 hours')::text AS sent_24h,
           COUNT(*) FILTER (WHERE transport='resend' AND status IN ('sent','sending')
                              AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '24 hours')::text AS resend_24h,
           EXTRACT(EPOCH FROM (NOW() - MIN(created_at) FILTER (WHERE status='failed' AND retry_after IS NOT NULL)))::text AS oldest
         FROM messages`,
      ),
      one<{ v: string }>(`SELECT v FROM quota_settings WHERE k='daily_budget'`),
    ]);

    const stuck = Number(stats?.oldest ?? 0) > 3600;

    return NextResponse.json(
      {
        ok: true,
        status: stuck ? 'degraded' : 'healthy',
        mode: 'immediate',           // no queue, no scheduler
        dry_run: process.env.DRY_RUN === 'true',
        last_24h: {
          sent: Number(stats?.sent_24h ?? 0),
          failed: Number(stats?.failed_24h ?? 0),
        },
        awaiting_retry: {
          count: Number(stats?.retrying ?? 0),
          oldest_seconds: Math.round(Number(stats?.oldest ?? 0)),
        },
        quota: quotaReport({
          usedToday: Number(stats?.resend_24h ?? 0),
          budget: Number(budgetRow?.v ?? DEFAULT_DAILY_BUDGET),
        }),
      },
      { status: stuck ? 503 : 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, status: 'unhealthy', error: (err as Error).message },
      { status: 503 },
    );
  }
}
