import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { digestTemplate, otpTemplate, noticeTemplate, escapeHtml, shell } from '../lib/render.ts';
import { mintToken, verifyToken } from '../lib/unsubscribe.ts';

describe('central templates', () => {
  test('OTP renders RTL Arabic with the code forced left-to-right', () => {
    const t = otpTemplate({ code: '4821', minutes: 5, appName: 'SQB', dir: 'rtl' });
    assert.match(t.html, /dir="rtl"/);
    assert.match(t.html, /lang="ar"/);
    assert.match(t.html, /direction:ltr/, 'digits must not be reordered by the RTL context');
    assert.match(t.html, /4821/);
    assert.ok(t.text.includes('4821'), 'a plain-text part improves spam scoring');
  });

  test('notice renders a CTA and keeps the caller direction', () => {
    const t = noticeTemplate({
      heading: 'Test', body: 'Body', dir: 'ltr',
      link: { label: 'Open', url: 'https://example.com/x' },
    });
    assert.match(t.html, /dir="ltr"/);
    assert.match(t.html, /https:\/\/example\.com\/x/);
    assert.ok(t.text.includes('Open: https://example.com/x'));
  });
});

describe('escaping', () => {
  test('caller content cannot inject markup', () => {
    const t = noticeTemplate({ heading: '<script>alert(1)</script>', body: 'x' });
    assert.ok(!t.html.includes('<script>'), 'a raw script tag must not survive');
    assert.match(t.html, /&lt;script&gt;/);
  });

  test('escapeHtml covers quotes and ampersands', () => {
    assert.equal(escapeHtml(`a&b"c'd<e>`), 'a&amp;b&quot;c&#39;d&lt;e&gt;');
  });
});

describe('shell', () => {
  test('wraps a fragment and can carry an unsubscribe link', () => {
    const html = shell('<p>hi</p>', { dir: 'rtl', unsubscribeUrl: 'https://gw/u/tok' });
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /dir="rtl"/);
    assert.match(html, /https:\/\/gw\/u\/tok/);
  });

  test('omits the unsubscribe block when there is no link', () => {
    assert.ok(!shell('<p>hi</p>', {}).includes('/u/'));
  });
});

describe('digest sample (used by the test page)', () => {
  test('groups by project and shows repeat counts', () => {
    const out = digestTemplate([
      { project: 'SQB', items: [
        { item: { title: 'DB connection refused' }, occurrences: 47, severity: 'critical', eventType: 'e' },
      ] },
      { project: 'Portfolio', items: [
        { item: { title: 'Resume downloaded' }, occurrences: 5, severity: 'info', eventType: 'd' },
      ] },
    ]);
    assert.match(out.subject, /52 events across 2 projects/);
    assert.match(out.html, /&times;47/);
  });

  test('Arabic and English items each keep their own direction', () => {
    const out = digestTemplate([
      { project: 'HR', items: [{ item: { title: 'طلب', dir: 'rtl' }, occurrences: 1, severity: 'info', eventType: 'r' }] },
      { project: 'P', items: [{ item: { title: 'New', dir: 'ltr' }, occurrences: 1, severity: 'info', eventType: 'c' }] },
    ]);
    assert.match(out.html, /dir="rtl"/);
    assert.match(out.html, /dir="ltr"/);
  });
});

describe('unsubscribe tokens', () => {
  test('round-trips and rejects tampering', () => {
    process.env.UNSUB_SECRET = 'test-secret-value';
    const token = mintToken({ project: 'medqize', email: 'a@b.com', scope: 'global' });
    const ok = verifyToken(token);
    assert.equal(ok.valid, true);
    assert.ok('payload' in ok && ok.payload.email === 'a@b.com');
    assert.equal(verifyToken(token.slice(0, -3) + 'xxx').valid, false);
    assert.equal(verifyToken('garbage').valid, false);
  });

  test('a token minted under a different secret is rejected', () => {
    process.env.UNSUB_SECRET = 'secret-one';
    const token = mintToken({ project: 'medqize', email: 'a@b.com', scope: 'global' });
    process.env.UNSUB_SECRET = 'secret-two';
    assert.equal(verifyToken(token).valid, false);
  });
});
