import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { authenticate } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { loadProjectLimits, loadQuotaSnapshot } from '@/lib/queue.ts';
import { quotaReport, admit, type Priority } from '@/lib/quota.ts';
import { lastRateLimit } from '@/lib/transports/index.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/quota[?priority=3]
 *
 * Exists so cron jobs stop guessing. MEDQIZE's lifecycle crons currently
 * hardcode LIMIT 50/100/100/50 = 300 candidates a day against a 100/day budget,
 * so most of that work is generated only to be dropped. They should ask first:
 *
 *   const q = await gateway.quota({ priority: 3 });
 *   const limit = Math.min(50, q.remaining_for_priority);
 */
export const GET = guard(async (req: Request) => {
  await ensureSchema();

  const auth = await authenticate(req);
  if (!auth) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const [snapshot, limits] = await Promise.all([
    loadQuotaSnapshot(),
    loadProjectLimits(auth.project.id),
  ]);

  const report = quotaReport(snapshot, limits);
  const asked = new URL(req.url).searchParams.get('priority');
  const priority = asked === null ? null : (Number(asked) as Priority);

  return NextResponse.json({
    ok: true,
    ...report,
    ...(priority !== null && priority >= 0 && priority <= 4
      ? { remaining_for_priority: admit(snapshot, priority, limits).remaining }
      : {}),
    provider_rate_limit: lastRateLimit,
  });
});
