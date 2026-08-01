/**
 * Reserved-capacity admission control.
 * ---------------------------------------------------------------------------
 * Everything in this file is PURE: it takes a snapshot of current usage and
 * answers "may this message send right now?". No database, no clock reads
 * beyond what is passed in — so the guarantees below are unit-testable.
 *
 * THE PROBLEM
 *   Resend free = 100 emails/day shared by every project. A flat pool lets a
 *   3,000-recipient broadcast eat the whole day and block a password-reset OTP.
 *   Fixed per-class quotas waste capacity whenever a class is idle.
 *
 * THE MODEL
 *   Each priority class has a RESERVE (capacity only that class and better may
 *   touch) and a CEILING (the most it may ever consume in the window).
 *   Reserves are floors that RELEASE when unused — if P0 has already sent 60,
 *   its reserve is spent and P1 sees the full remaining pool.
 *
 * THE GUARANTEE (verified in tests/quota.test.ts)
 *   For a non-P0 message to be admitted, the capacity still held for P0 must
 *   remain covered. So no burst of lower-priority mail can ever reduce P0's
 *   available capacity below RESERVE[0]. Proof by the arithmetic below;
 *   the test drives it adversarially and asserts P0 still gets its full 25.
 *
 * WHY A ROLLING 24h WINDOW, NOT A CALENDAR DAY
 *   Resend does not document which timezone its daily counter resets in. Our
 *   users are UTC+3. If we reset at Riyadh midnight and Resend resets at UTC,
 *   there is a 3-hour band where a burst counts against Resend's PREVIOUS day
 *   and our NEW day — 190 sends in 24h with both sides believing they are
 *   under 100. A rolling 24h window is a strict superset of any calendar-day
 *   window, so it cannot be violated wherever the provider draws the line.
 */

export const PRIORITIES = [0, 1, 2, 3, 4] as const;
export type Priority = 0 | 1 | 2 | 3 | 4;

export interface ClassPolicy {
  priority: Priority;
  name: string;
  reserve: number;
  ceiling: number;
  ttlSeconds: number;
  onExpiry: 'dead' | 'drop' | 'fold';
}

export interface QuotaSnapshot {
  dailyCeiling: number;
  monthlyCeiling: number;
  burstMultiplier: number;
  /** Sends in the rolling 24h window, indexed by priority. Length 5. */
  usedByPriority: number[];
  /** Sends this calendar month (UTC). */
  monthUsed: number;
  policies: ClassPolicy[];
  now: Date;
}

export interface ProjectLimits {
  slug: string;
  dailyMax: number;
  monthlyMax: number;
  usedToday: number;
  usedThisMonth: number;
}

export type DenyReason =
  | 'daily_ceiling'
  | 'class_ceiling'
  | 'monthly_ceiling'
  | 'project_daily_cap'
  | 'project_monthly_cap';

export interface Verdict {
  ok: boolean;
  reason?: DenyReason;
  /** How many more of this class could send right now (0 when !ok). */
  remaining: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function policyFor(snap: QuotaSnapshot, k: Priority): ClassPolicy {
  const p = snap.policies.find((x) => x.priority === k);
  if (!p) throw new Error(`No quota policy configured for priority ${k}`);
  return p;
}

/** Days left in the current UTC month, counting today. Always >= 1. */
export function daysRemainingInMonthUTC(now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return daysInMonth - now.getUTCDate() + 1;
}

/**
 * Monthly governor. 95/day x 31 days = 2945 > 2900, so in long months the
 * monthly budget binds before the daily one. Spread what is left evenly over
 * the days remaining, with a small burst allowance so a busy day can borrow
 * from quiet ones.
 *
 * Scales CEILINGS only, never reserves, and P0/P1 are exempt: an OTP is not
 * negotiable because it happens to be the 28th of the month.
 */
export function effectiveCeiling(snap: QuotaSnapshot, k: Priority): number {
  const base = policyFor(snap, k).ceiling;
  if (k <= 1) return base;

  const monthLeft = Math.max(0, snap.monthlyCeiling - snap.monthUsed);
  const evenShare = monthLeft / daysRemainingInMonthUTC(snap.now);
  const governed = clamp(Math.round(evenShare * snap.burstMultiplier), 0, snap.dailyCeiling);
  return Math.min(base, governed);
}

/**
 * Reserves may never consume more than this share of the daily budget.
 * The remainder is the free pool that unreserved classes (P3, P4) live on.
 */
const RESERVE_BUDGET_FRACTION = 0.8;

/**
 * Scale factor applied to every configured reserve.
 *
 * Reserves are written for a full-size budget. When the operator lowers
 * `dailyCeiling` — as during migration, where legacy senders still consume part
 * of the real provider quota and the gateway only governs its own share — the
 * configured reserves can sum to more than the entire budget. Left unscaled,
 * that permanently starves every class below the last reserved one: at a
 * ceiling of 40 with reserves of 25/20/10, P2, P3 and P4 can never send a
 * single email, because 40 − 55 is already negative before anything is used.
 *
 * Scaling proportionally preserves the ORDERING and the relative weights while
 * guaranteeing the floors fit inside the budget with a free pool left over.
 */
export function reserveScale(snap: QuotaSnapshot): number {
  const total = snap.policies.reduce((n, p) => n + p.reserve, 0);
  if (total <= 0) return 1;
  const allowed = snap.dailyCeiling * RESERVE_BUDGET_FRACTION;
  return total <= allowed ? 1 : allowed / total;
}

/** A class's reserve after scaling to fit the current budget. */
export function effectiveReserve(snap: QuotaSnapshot, k: Priority): number {
  return Math.floor(policyFor(snap, k).reserve * reserveScale(snap));
}

/**
 * Capacity still being held in trust for strictly-higher-priority classes.
 * This single term is what makes the starvation guarantee work.
 */
export function reserveHeldAbove(snap: QuotaSnapshot, k: Priority): number {
  let held = 0;
  for (let j = 0; j < k; j++) {
    held += Math.max(0, effectiveReserve(snap, j as Priority) - (snap.usedByPriority[j] ?? 0));
  }
  return held;
}

/**
 * How many more messages of class `k` may send right now, ignoring per-project
 * limits. Never negative.
 */
export function remainingForClass(snap: QuotaSnapshot, k: Priority): number {
  const usedTotal = snap.usedByPriority.reduce((a, b) => a + b, 0);
  const byDaily = snap.dailyCeiling - usedTotal - reserveHeldAbove(snap, k);
  const byClass = effectiveCeiling(snap, k) - (snap.usedByPriority[k] ?? 0);
  const byMonth = snap.monthlyCeiling - snap.monthUsed;
  return Math.max(0, Math.min(byDaily, byClass, byMonth));
}

/**
 * The admission decision. Order matters only for the reported reason — the
 * per-project cap is checked first because a runaway fan-out loop in one
 * project is the realistic failure, far more likely than adversarial priority
 * abuse, and we want the error to say so.
 */
export function admit(snap: QuotaSnapshot, k: Priority, project?: ProjectLimits): Verdict {
  if (project) {
    if (project.usedToday >= project.dailyMax) return { ok: false, reason: 'project_daily_cap', remaining: 0 };
    if (project.usedThisMonth >= project.monthlyMax) return { ok: false, reason: 'project_monthly_cap', remaining: 0 };
  }

  if (snap.monthUsed >= snap.monthlyCeiling) return { ok: false, reason: 'monthly_ceiling', remaining: 0 };

  const usedTotal = snap.usedByPriority.reduce((a, b) => a + b, 0);
  if (snap.dailyCeiling - usedTotal - reserveHeldAbove(snap, k) < 1) {
    return { ok: false, reason: 'daily_ceiling', remaining: 0 };
  }

  if ((snap.usedByPriority[k] ?? 0) >= effectiveCeiling(snap, k)) {
    return { ok: false, reason: 'class_ceiling', remaining: 0 };
  }

  let remaining = remainingForClass(snap, k);
  if (project) {
    remaining = Math.min(
      remaining,
      project.dailyMax - project.usedToday,
      project.monthlyMax - project.usedThisMonth,
    );
  }
  return { ok: true, remaining: Math.max(0, remaining) };
}

/** Shape returned by GET /api/v1/quota so callers can size a batch honestly. */
export function quotaReport(snap: QuotaSnapshot, project?: ProjectLimits) {
  const usedTotal = snap.usedByPriority.reduce((a, b) => a + b, 0);
  return {
    window: 'rolling_24h',
    daily_ceiling: snap.dailyCeiling,
    daily_used: usedTotal,
    monthly_ceiling: snap.monthlyCeiling,
    monthly_used: snap.monthUsed,
    by_priority: PRIORITIES.map((k) => {
      const pol = policyFor(snap, k);
      return {
        priority: k,
        name: pol.name,
        reserve: pol.reserve,
        effective_reserve: effectiveReserve(snap, k),
        ceiling: pol.ceiling,
        effective_ceiling: effectiveCeiling(snap, k),
        used: snap.usedByPriority[k] ?? 0,
        remaining: admit(snap, k, project).remaining,
      };
    }),
    project: project
      ? {
          slug: project.slug,
          daily_max: project.dailyMax,
          daily_used: project.usedToday,
          monthly_max: project.monthlyMax,
          monthly_used: project.usedThisMonth,
        }
      : undefined,
  };
}
