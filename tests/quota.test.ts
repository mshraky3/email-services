import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DAILY_BUDGET, evaluate, quotaReport } from '../lib/quota.ts';
import { normalizeSeverity } from '../lib/types.ts';

/**
 * v3 quota is one question: is there Resend budget left?
 *
 * Nothing is ever refused — when the answer is no, the send path switches to
 * Gmail. So there is no admission control to test, only the switch-over point.
 */

describe('budget evaluation', () => {
  test('under budget, Resend carries the mail', () => {
    const v = evaluate({ usedToday: 10, budget: 95 });
    assert.equal(v.resendAvailable, true);
    assert.equal(v.remaining, 85);
  });

  test('at the budget, Gmail takes over', () => {
    const v = evaluate({ usedToday: 95, budget: 95 });
    assert.equal(v.resendAvailable, false);
    assert.equal(v.remaining, 0);
  });

  test('past the budget, remaining never goes negative', () => {
    // Concurrent sends can overshoot slightly; the report must stay sane.
    const v = evaluate({ usedToday: 120, budget: 95 });
    assert.equal(v.resendAvailable, false);
    assert.equal(v.remaining, 0);
  });

  test('the default leaves headroom under the real provider limit of 100', () => {
    assert.ok(DEFAULT_DAILY_BUDGET < 100, 'a burst must never earn a hard 429');
    assert.ok(DEFAULT_DAILY_BUDGET >= 90, 'but the headroom should not waste the plan');
  });

  test('a zero budget sends everything over Gmail', () => {
    // A valid way to take Resend out of the loop entirely.
    assert.equal(evaluate({ usedToday: 0, budget: 0 }).resendAvailable, false);
  });
});

describe('quota report', () => {
  test('states plainly whether Resend is still carrying mail', () => {
    const r = quotaReport({ usedToday: 40, budget: 95 });
    assert.equal(r.window, 'rolling_24h');
    assert.equal(r.used, 40);
    assert.equal(r.remaining, 55);
    assert.equal(r.resend_available, true);
    assert.equal(r.project, undefined);
  });

  test('includes the caller project when given', () => {
    const r = quotaReport({ usedToday: 40, budget: 95 }, { slug: 'hr', usedToday: 12, dailyMax: 50 });
    assert.equal(r.project?.slug, 'hr');
    assert.equal(r.project?.remaining, 38);
  });

  test('a project over its own cap reports zero, not a negative', () => {
    const r = quotaReport({ usedToday: 10, budget: 95 }, { slug: 'hr', usedToday: 70, dailyMax: 50 });
    assert.equal(r.project?.remaining, 0);
  });
});

describe('severity normalization', () => {
  test("maps the projects' own vocabulary onto our three levels", () => {
    // MEDQIZE and HR- both classify errors as CRITICAL / HIGH / MEDIUM / LOW.
    assert.equal(normalizeSeverity('CRITICAL'), 'critical');
    assert.equal(normalizeSeverity('HIGH'), 'warn');
    assert.equal(normalizeSeverity('MEDIUM'), 'info');
    assert.equal(normalizeSeverity('LOW'), 'info');
  });

  test('passes our own levels through unchanged', () => {
    assert.equal(normalizeSeverity('critical'), 'critical');
    assert.equal(normalizeSeverity('warn'), 'warn');
    assert.equal(normalizeSeverity('info'), 'info');
  });

  test('degrades anything unknown to info rather than throwing', () => {
    // An unrecognised label is not a good reason to lose an error report.
    for (const v of ['banana', '', null, undefined, 42]) {
      assert.equal(normalizeSeverity(v), 'info');
    }
  });
});
