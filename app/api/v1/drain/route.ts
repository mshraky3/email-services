import { NextResponse } from 'next/server';
import { guard } from '@/lib/route.ts';
import { checkSecret } from '@/lib/auth.ts';
import { ensureSchema } from '@/lib/db.ts';
import { drain } from '@/lib/queue.ts';
import { flushDue } from '@/lib/digest.ts';
import { flushDeps } from '@/lib/ingest.ts';
import { reputationCheck } from '@/lib/suppression.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/v1/drain — one scheduler tick.
 *
 * Vercel Hobby crons run at most once a day with +/-59 min precision, which is
 * useless for a queue. Drive this from an external scheduler instead
 * (cron-job.org every 5 min is the primary; a GitHub Actions schedule every
 * 15 min is the backup). Inbound API traffic also drains opportunistically, so
 * a stalled scheduler degrades throughput rather than stopping the queue.
 *
 * Safe to call concurrently: an advisory lock makes overlapping ticks a no-op.
 */
async function handle(req: Request) {
  // CRON_SECRET is accepted too: Vercel's built-in cron sends that name and
  // cannot be configured to send another.
  if (!checkSecret(req, 'DRAIN_SECRET', 'CRON_SECRET')) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  await ensureSchema();

  const source = new URL(req.url).searchParams.get('source') ?? 'external-cron';
  const result = await drain({ source, budgetMs: 25_000, flushDigests: () => flushDue(flushDeps) });

  // Cheap and only meaningful over a week of data, so once per tick is fine.
  const reputation = await reputationCheck().catch(() => null);

  return NextResponse.json({ ok: true, ...result, reputation });
}

export const POST = guard(handle);
// GET is accepted too: several free schedulers can only issue GETs.
export const GET = guard(handle);
