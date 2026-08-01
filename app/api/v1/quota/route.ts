import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema, one } from '@/lib/db.ts';
import { DEFAULT_DAILY_BUDGET, evaluate, quotaReport } from '@/lib/quota.ts';
import { lastRateLimit } from '@/lib/transports/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/quota — how much Resend budget is left.
 *
 * Informational. Nothing is refused when it runs out; mail simply goes over
 * Gmail instead. Useful for the dashboard and for a cron that would rather
 * spread its work than spill onto the fallback transport.
 */
export const GET = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const [used, budgetRow, mine] = await Promise.all([
    one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages
        WHERE transport='resend' AND status IN ('sent','sending')
          AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '24 hours'`,
    ),
    one<{ v: string }>(`SELECT v FROM quota_settings WHERE k='daily_budget'`),
    one<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages
        WHERE project_id=$1 AND transport='resend' AND status IN ('sent','sending')
          AND COALESCE(sent_at, created_at) > NOW() - INTERVAL '24 hours'`,
      [auth.project.id],
    ),
  ]);

  const state = {
    usedToday: Number(used?.n ?? 0),
    budget: Number(budgetRow?.v ?? DEFAULT_DAILY_BUDGET),
  };

  return NextResponse.json({
    ok: true,
    ...quotaReport(state, {
      slug: auth.project.slug,
      usedToday: Number(mine?.n ?? 0),
      dailyMax: auth.project.daily_max,
    }),
    note: evaluate(state).resendAvailable
      ? 'Resend is carrying mail normally.'
      : 'Resend budget spent — mail is going over Gmail until the window rolls.',
    provider_rate_limit: lastRateLimit,
  });
});
