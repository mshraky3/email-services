/**
 * Quota: which transport carries this message.
 * ---------------------------------------------------------------------------
 * That is the whole job. There is no admission control, because nothing is
 * ever refused — if the Resend budget is gone the message goes over Gmail
 * instead. Everything sends, immediately, on arrival.
 *
 * This replaced a reserved-capacity scheduler with per-priority reserves,
 * ceilings and a monthly governor. All of that existed to answer "what do we
 * drop when the budget is full?", and once the answer is "nothing, we spill to
 * Gmail", the machinery has nothing left to protect. Real volume has never
 * approached 100/day, so it was solving a problem that does not exist.
 *
 * WHY A ROLLING 24h WINDOW, NOT A CALENDAR DAY
 *   Resend does not document which timezone its daily counter resets in. A
 *   rolling 24h window is a strict superset of any calendar-day window, so we
 *   cannot overshoot wherever the provider happens to draw the line.
 */

/** Under the real 100 so a burst never gets a hard 429 from the provider. */
export const DEFAULT_DAILY_BUDGET = 95;

export interface QuotaState {
  /** Resend sends in the rolling 24h window. */
  usedToday: number;
  /** Budget before we start spilling to Gmail. */
  budget: number;
}

export interface QuotaVerdict {
  /** False once the Resend budget is spent — the caller should use Gmail. */
  resendAvailable: boolean;
  remaining: number;
  usedToday: number;
  budget: number;
}

export function evaluate(state: QuotaState): QuotaVerdict {
  const remaining = Math.max(0, state.budget - state.usedToday);
  return {
    resendAvailable: remaining > 0,
    remaining,
    usedToday: state.usedToday,
    budget: state.budget,
  };
}

/** Shape returned by GET /api/v1/quota. */
export function quotaReport(state: QuotaState, project?: { slug: string; usedToday: number; dailyMax: number }) {
  const v = evaluate(state);
  return {
    window: 'rolling_24h',
    budget: v.budget,
    used: v.usedToday,
    remaining: v.remaining,
    // Once this is false, mail still goes out — over Gmail.
    resend_available: v.resendAvailable,
    project: project
      ? {
          slug: project.slug,
          daily_max: project.dailyMax,
          used: project.usedToday,
          remaining: Math.max(0, project.dailyMax - project.usedToday),
        }
      : undefined,
  };
}
