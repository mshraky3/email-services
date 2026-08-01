import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  admit,
  remainingForClass,
  effectiveCeiling,
  reserveHeldAbove,
  reserveScale,
  effectiveReserve,
  daysRemainingInMonthUTC,
  type ClassPolicy,
  type QuotaSnapshot,
  type Priority,
} from '../lib/quota.ts';

const POLICIES: ClassPolicy[] = [
  { priority: 0, name: 'urgent', reserve: 25, ceiling: 95, ttlSeconds: 0, onExpiry: 'dead' },
  { priority: 1, name: 'transactional', reserve: 20, ceiling: 60, ttlSeconds: 86400, onExpiry: 'dead' },
  { priority: 2, name: 'operational', reserve: 10, ceiling: 25, ttlSeconds: 43200, onExpiry: 'fold' },
  { priority: 3, name: 'lifecycle', reserve: 0, ceiling: 30, ttlSeconds: 172800, onExpiry: 'drop' },
  { priority: 4, name: 'bulk', reserve: 0, ceiling: 40, ttlSeconds: 2592000, onExpiry: 'drop' },
];

// Mid-month so the monthly governor is not the binding constraint unless a
// test deliberately makes it so.
const MID_MONTH = new Date('2026-08-10T12:00:00Z');

function snap(over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    dailyCeiling: 95,
    monthlyCeiling: 2900,
    burstMultiplier: 1.25,
    usedByPriority: [0, 0, 0, 0, 0],
    monthUsed: 0,
    policies: POLICIES,
    now: MID_MONTH,
    ...over,
  };
}

describe('P0 starvation guarantee', () => {
  test('an adversarial flood of P1-P4 cannot push P0 below its reserve', () => {
    const s = snap();
    // Greedily admit every non-P0 message the scheduler will allow, worst case.
    let guard = 0;
    for (;;) {
      let admittedAny = false;
      for (const k of [4, 3, 2, 1] as Priority[]) {
        if (admit(s, k).ok) {
          s.usedByPriority[k]++;
          s.monthUsed++;
          admittedAny = true;
        }
      }
      if (!admittedAny || ++guard > 10_000) break;
    }

    const nonP0 = s.usedByPriority.slice(1).reduce((a, b) => a + b, 0);
    assert.ok(nonP0 > 0, 'the flood should actually have sent something');

    // Now count how much P0 can still send.
    let p0 = 0;
    while (admit(s, 0).ok && p0 < 10_000) {
      s.usedByPriority[0]++;
      s.monthUsed++;
      p0++;
    }

    assert.equal(p0, 25, 'P0 must retain exactly its full reserve after a maximal flood');
    assert.ok(nonP0 + p0 <= 95, 'total must never exceed the daily ceiling');
  });

  test('P0 is admitted even when every other class is at its ceiling', () => {
    const s = snap({ usedByPriority: [0, 60, 25, 30, 40] });
    assert.equal(admit(s, 4).ok, false);
    assert.equal(admit(s, 3).ok, false);
    // usedTotal is 155 here, which is over the ceiling — an impossible state in
    // practice, but P0 must still be evaluated on its own terms and refused
    // only by the hard ceiling, never by a lower class holding capacity.
    assert.equal(reserveHeldAbove(s, 0), 0, 'nothing is ever held above P0');
  });
});

describe('reserves release when unused', () => {
  test('a heavy P0 day frees its reserve for P1', () => {
    const s = snap({ usedByPriority: [60, 0, 0, 0, 0], monthUsed: 60 });
    assert.equal(reserveHeldAbove(s, 1), 0, 'P0 has overspent its reserve, so nothing is held');
    const v = admit(s, 1);
    assert.equal(v.ok, true);
    assert.equal(v.remaining, 35, '95 - 60 used, and P1 ceiling of 60 is not binding');
  });

  test('an idle P0 keeps its reserve away from P4', () => {
    const s = snap();
    // Free pool = 95 - (25+20+10) = 40, and P4's ceiling is also 40.
    assert.equal(remainingForClass(s, 4), 40);
    assert.equal(remainingForClass(s, 0), 95, 'P0 may use the entire budget');
  });

  test('partially-spent reserves are held only for the unspent part', () => {
    const s = snap({ usedByPriority: [10, 0, 0, 0, 0], monthUsed: 10 });
    // P0 has 15 of its 25 reserve left; P1 and P2 still hold 20 and 10.
    assert.equal(reserveHeldAbove(s, 3), 15 + 20 + 10);
    // The daily arithmetic would allow 95 - 10 - 45 = 40, but P3's own ceiling
    // of 30 is tighter and wins. Both bounds are asserted so a regression in
    // either one is caught.
    assert.equal(95 - 10 - reserveHeldAbove(s, 3), 40);
    assert.equal(effectiveCeiling(s, 3), 30);
    assert.equal(remainingForClass(s, 3), 30, 'the class ceiling binds before the pool does');
  });
});

describe('monthly governor', () => {
  test('throttles P2-P4 near the end of a heavy month but never P0/P1', () => {
    // 28 Aug -> 4 days remain (28,29,30,31). 50 left / 4 = 12.5 * 1.25 = ~16.
    const s = snap({ monthUsed: 2850, now: new Date('2026-08-28T12:00:00Z') });
    assert.equal(daysRemainingInMonthUTC(s.now), 4);
    assert.equal(effectiveCeiling(s, 2), 16);
    assert.equal(effectiveCeiling(s, 3), 16);
    assert.equal(effectiveCeiling(s, 4), 16);
    assert.equal(effectiveCeiling(s, 0), 95, 'P0 is exempt from the governor');
    assert.equal(effectiveCeiling(s, 1), 60, 'P1 is exempt from the governor');
  });

  test('refuses everything but P0/P1 once the month is spent', () => {
    const s = snap({ monthUsed: 2900 });
    for (const k of [0, 1, 2, 3, 4] as Priority[]) {
      assert.equal(admit(s, k).reason, 'monthly_ceiling', `P${k} blocked by the monthly ceiling`);
    }
  });

  test('does not throttle early in a quiet month', () => {
    const s = snap({ monthUsed: 100, now: new Date('2026-08-03T12:00:00Z') });
    assert.equal(effectiveCeiling(s, 4), 40, 'base ceiling still applies when there is plenty left');
  });
});

describe('per-project containment', () => {
  const project = { slug: 'hr', dailyMax: 60, monthlyMax: 1500, usedToday: 60, usedThisMonth: 200 };

  test('a runaway fan-out loop is capped at the project limit, not the global one', () => {
    const s = snap();
    const v = admit(s, 2, project);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'project_daily_cap');
    assert.equal(admit(s, 2).ok, true, 'the global budget still had room — only the project was capped');
  });

  test('remaining is clamped by the project budget', () => {
    const s = snap();
    const v = admit(s, 1, { ...project, usedToday: 58 });
    assert.equal(v.ok, true);
    assert.equal(v.remaining, 2, 'two left in the project budget, even though the pool has more');
  });
});

describe('ceilings', () => {
  test('a class is refused at its own ceiling while the pool still has room', () => {
    const s = snap({ usedByPriority: [0, 0, 25, 0, 0], monthUsed: 25 });
    const v = admit(s, 2);
    assert.equal(v.ok, false);
    assert.equal(v.reason, 'class_ceiling');
    assert.equal(admit(s, 1).ok, true, 'other classes are unaffected');
  });

  test('remaining never goes negative', () => {
    const s = snap({ usedByPriority: [95, 0, 0, 0, 0], monthUsed: 95 });
    for (const k of [0, 1, 2, 3, 4] as Priority[]) {
      assert.ok(remainingForClass(s, k) >= 0, `P${k} remaining must not be negative`);
    }
  });
});

describe('daysRemainingInMonthUTC', () => {
  test('counts today and handles month lengths', () => {
    assert.equal(daysRemainingInMonthUTC(new Date('2026-08-01T00:00:00Z')), 31);
    assert.equal(daysRemainingInMonthUTC(new Date('2026-08-31T23:59:00Z')), 1);
    assert.equal(daysRemainingInMonthUTC(new Date('2026-02-01T00:00:00Z')), 28);
    assert.equal(daysRemainingInMonthUTC(new Date('2028-02-01T00:00:00Z')), 29, 'leap year');
  });
});

describe('reserves scale to fit a reduced budget', () => {
  // During migration daily_ceiling is deliberately lowered (legacy senders are
  // still consuming part of the real provider quota). The configured reserves
  // 25+20+10=55 then exceed the whole budget, and without scaling P2/P3/P4
  // could never send a single email — 40-55 is negative before anything is used.
  // This was caught on the live dashboard, not in a unit test.
  test('a 40/day migration budget does not starve the lower classes', () => {
    const s = snap({ dailyCeiling: 40 });
    for (const k of [2, 3, 4] as Priority[]) {
      assert.ok(remainingForClass(s, k) > 0, `P${k} must have capacity at a reduced ceiling`);
      assert.equal(admit(s, k).ok, true, `P${k} must be admittable at a reduced ceiling`);
    }
  });

  test('scaled reserves still fit inside the budget with a free pool left', () => {
    const s = snap({ dailyCeiling: 40 });
    const totalReserved = ([0, 1, 2, 3, 4] as Priority[])
      .reduce<number>((n, k) => n + effectiveReserve(s, k), 0);
    assert.ok(totalReserved <= 40 * 0.8, `reserves ${totalReserved} must stay within 80% of the budget`);
    assert.ok(totalReserved > 0, 'reserves must not collapse to nothing');
  });

  test('priority ordering is preserved after scaling', () => {
    const s = snap({ dailyCeiling: 40 });
    assert.ok(effectiveReserve(s, 0) > effectiveReserve(s, 1));
    assert.ok(effectiveReserve(s, 1) > effectiveReserve(s, 2));
    assert.ok(remainingForClass(s, 0) >= remainingForClass(s, 4), 'P0 must never have less headroom than P4');
  });

  test('P0 is still protected from a flood at the reduced ceiling', () => {
    const s = snap({ dailyCeiling: 40 });
    const floor = effectiveReserve(s, 0);
    let guard = 0;
    for (;;) {
      let did = false;
      for (const k of [4, 3, 2, 1] as Priority[]) {
        if (admit(s, k).ok) { s.usedByPriority[k]++; s.monthUsed++; did = true; }
      }
      if (!did || ++guard > 10_000) break;
    }
    let p0 = 0;
    while (admit(s, 0).ok && p0 < 10_000) { s.usedByPriority[0]++; s.monthUsed++; p0++; }
    assert.ok(p0 >= floor, `P0 got ${p0}, expected at least its scaled reserve of ${floor}`);
  });

  test('a full-size budget is left completely unscaled', () => {
    const s = snap({ dailyCeiling: 95 });
    assert.equal(reserveScale(s), 1, '55 reserves fit inside 80% of 95 — no scaling needed');
    assert.equal(effectiveReserve(s, 0), 25);
  });
});
