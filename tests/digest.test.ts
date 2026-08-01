import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { windowFor, renderTemplate, shouldEscalate } from '../lib/digest.ts';
import { digestTemplate, otpTemplate, escapeHtml } from '../lib/render.ts';
import { mintToken, verifyToken } from '../lib/unsubscribe.ts';
import { normalizeSeverity } from '../lib/types.ts';

describe('digest windows', () => {
  test('hourly windows are exactly one hour and aligned', () => {
    const w = windowFor('hourly', new Date('2026-08-10T14:37:12Z'));
    assert.equal(w.start.toISOString(), '2026-08-10T14:00:00.000Z');
    assert.equal(w.end.toISOString(), '2026-08-10T15:00:00.000Z');
  });

  test('daily windows close at the next Riyadh flush time, not at midnight', () => {
    // 10:00 UTC = 13:00 Riyadh, which is after the 07:00 flush and before 19:00.
    const w = windowFor('daily', new Date('2026-08-10T10:00:00Z'));
    assert.equal(w.end.toISOString(), '2026-08-10T16:00:00.000Z', '19:00 Riyadh == 16:00 UTC');
  });

  test('an evening event waits for the morning flush, not a full day', () => {
    // 18:00 UTC = 21:00 Riyadh, past the 19:00 flush.
    const w = windowFor('daily', new Date('2026-08-10T18:00:00Z'));
    assert.equal(w.end.toISOString(), '2026-08-11T04:00:00.000Z', '07:00 Riyadh next day == 04:00 UTC');
    const waitHours = (w.end.getTime() - new Date('2026-08-10T18:00:00Z').getTime()) / 3_600_000;
    assert.ok(waitHours <= 12, `waited ${waitHours}h — a daily digest must never hold an item for a full day`);
  });

  test('every window contains the instant that produced it', () => {
    for (const iso of ['2026-08-10T03:00:00Z', '2026-08-10T05:00:00Z', '2026-08-10T16:30:00Z', '2026-08-10T23:59:00Z']) {
      const now = new Date(iso);
      const w = windowFor('daily', now);
      assert.ok(w.start <= now && now < w.end, `${iso} must fall inside [${w.start.toISOString()}, ${w.end.toISOString()})`);
    }
  });
});

describe('template placeholders', () => {
  test('renders nested paths and tolerates missing ones', () => {
    const ctx = { event_type: 'hr.owner.system_error', data: { error_key: 'DB_CONN' } };
    assert.equal(renderTemplate('{{event_type}}:{{data.error_key}}', ctx), 'hr.owner.system_error:DB_CONN');
    assert.equal(renderTemplate('{{data.missing}}', ctx), '');
    assert.equal(renderTemplate('owner:daily', ctx), 'owner:daily');
  });
});

describe('escalation predicate', () => {
  const policy = { escalate_when: { severity: ['CRITICAL'] } };

  test('critical escalates and is case-insensitive', () => {
    assert.equal(shouldEscalate(policy, { severity: 'CRITICAL' }), true);
    assert.equal(shouldEscalate(policy, { severity: 'critical' }), true);
  });

  test('anything else is buffered', () => {
    assert.equal(shouldEscalate(policy, { severity: 'HIGH' }), false);
    assert.equal(shouldEscalate(policy, { severity: 'info' }), false);
    assert.equal(shouldEscalate(policy, {}), false);
  });

  test('no rule means never escalate', () => {
    assert.equal(shouldEscalate({ escalate_when: null }, { severity: 'CRITICAL' }), false);
  });
});

describe('digest rendering', () => {
  test('collapses many events into one email and shows repeat counts', () => {
    const out = digestTemplate([
      {
        project: 'SQB',
        items: [
          { item: { title: 'DB connection refused' }, occurrences: 47, severity: 'critical', eventType: 'err' },
          { item: { title: 'Contact form', summary: 'Ahmed asks about pricing' }, occurrences: 3, severity: 'info', eventType: 'contact' },
        ],
      },
      {
        project: 'Portfolio',
        items: [{ item: { title: 'Resume downloaded' }, occurrences: 5, severity: 'info', eventType: 'resume' }],
      },
    ]);

    assert.match(out.subject, /55 events across 2 projects/);
    assert.match(out.html, /&times;47/, 'repeat count must be visible, not silently swallowed');
    assert.match(out.html, /SQB/);
    assert.match(out.html, /Portfolio/);
    assert.ok(out.text.includes('DB connection refused'), 'a plain-text part is required for spam scoring');
  });

  test('mixed Arabic and English items each carry their own direction', () => {
    const out = digestTemplate([
      { project: 'HR', items: [{ item: { title: 'طلب جديد', dir: 'rtl' }, occurrences: 1, severity: 'info', eventType: 'r' }] },
      { project: 'Portfolio', items: [{ item: { title: 'New contact', dir: 'ltr' }, occurrences: 1, severity: 'info', eventType: 'c' }] },
    ]);
    assert.match(out.html, /dir="rtl"/);
    assert.match(out.html, /dir="ltr"/);
  });
});

describe('escaping', () => {
  test('user-supplied content cannot inject markup', () => {
    const out = digestTemplate([
      { project: 'X', items: [{ item: { title: '<script>alert(1)</script>' }, occurrences: 1, severity: 'info', eventType: 'e' }] },
    ]);
    assert.ok(!out.html.includes('<script>'), 'raw script tag must not survive into the body');
    assert.match(out.html, /&lt;script&gt;/);
  });

  test('escapeHtml handles quotes and ampersands', () => {
    assert.equal(escapeHtml(`a&b"c'd<e>`), 'a&amp;b&quot;c&#39;d&lt;e&gt;');
  });
});

describe('central OTP template', () => {
  test('renders RTL Arabic with an LTR code block', () => {
    const t = otpTemplate({ code: '4821', minutes: 5, appName: 'SQB', dir: 'rtl' });
    assert.match(t.html, /dir="rtl"/);
    assert.match(t.html, /lang="ar"/);
    assert.match(t.html, /direction:ltr/, 'digits must not be reordered by the RTL context');
    assert.match(t.html, /4821/);
    assert.ok(t.text.includes('4821'));
  });
});

describe('unsubscribe tokens', () => {
  test('round-trips and rejects tampering', () => {
    process.env.UNSUB_SECRET = 'test-secret-value';
    const token = mintToken({ project: 'medqize', email: 'a@b.com', scope: 'global' });

    const ok = verifyToken(token);
    assert.equal(ok.valid, true);
    assert.ok('payload' in ok && ok.payload.email === 'a@b.com');

    assert.equal(verifyToken(token.slice(0, -3) + 'xxx').valid, false, 'a tampered signature must fail');
    assert.equal(verifyToken('garbage').valid, false);
  });

  test('a token minted under a different secret is rejected', () => {
    process.env.UNSUB_SECRET = 'secret-one';
    const token = mintToken({ project: 'medqize', email: 'a@b.com', scope: 'global' });
    process.env.UNSUB_SECRET = 'secret-two';
    assert.equal(verifyToken(token).valid, false);
  });
});

describe('severity normalization', () => {
  test('maps the projects\' own vocabulary onto our three levels', () => {
    // MEDQIZE's errorNotificationService and HR-'s both classify errors as
    // CRITICAL / HIGH / MEDIUM / LOW. Passing those straight through violates
    // the digest_buffer CHECK constraint and 500s the request — caught live by
    // the smoke test before any project was migrated.
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

  test('degrades unknown or missing values to info rather than throwing', () => {
    // An unrecognised label is not a good reason to lose an error report.
    assert.equal(normalizeSeverity('banana'), 'info');
    assert.equal(normalizeSeverity(undefined), 'info');
    assert.equal(normalizeSeverity(null), 'info');
    assert.equal(normalizeSeverity(''), 'info');
    assert.equal(normalizeSeverity(42), 'info');
  });

  test('every output satisfies the digest_buffer CHECK constraint', () => {
    const allowed = new Set(['info', 'warn', 'critical']);
    for (const input of ['CRITICAL', 'High', 'medium', 'LOW', 'fatal', 'Warning', 'nonsense', '', null, undefined]) {
      assert.ok(allowed.has(normalizeSeverity(input)), `${input} produced an invalid severity`);
    }
  });
});
