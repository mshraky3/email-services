/**
 * End-to-end smoke test against a running gateway.
 *
 *   npm run smoke     (with GATEWAY_URL and SMOKE_KEY set)
 *
 * Runs with DRY_RUN=true, so nothing is emailed. What is being proven is the
 * DECISION each message gets — the part that can actually lose mail or spend
 * budget wrongly.
 */
import './_env.mjs';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:3100';
const KEY = process.env.SMOKE_KEY;
const TO = process.env.SMOKE_TO ?? 'alshraky3@gmail.com';
const PROD = 'https://medquiz.vercel.app/';

if (!KEY) {
  console.error('\n  SMOKE_KEY is required — take it from `npm run db:seed`.\n');
  process.exit(1);
}

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
};
const get = async (path) => {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
};

const run = Date.now();
console.log(`\n  Gateway: ${BASE}\n`);

// ── health and auth ─────────────────────────────────────────────────────────
const health = await get('/api/v1/health');
check('health responds', health.http === 200 || health.http === 503, `status ${health.http}`);
check('runs in immediate mode — no queue', health.mode === 'immediate', JSON.stringify(health.mode));
check('dry run is on (nothing is emailed)', health.dry_run === true, 'set DRY_RUN=true to smoke test');

const noAuth = await fetch(`${BASE}/api/v1/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ to: TO, subject: 'x', text: 'x' }),
});
check('unauthenticated send is rejected', noAuth.status === 401, `got ${noAuth.status}`);

// ── the send is immediate ───────────────────────────────────────────────────
const otp = await post('/api/v1/send', {
  event: 'medqize.otp.signup', to: `otp.${run}@example.com`,
  template: 'otp', data: { code: '4821' }, sourceOrigin: PROD,
  idempotencyKey: `smoke-otp-${run}`,
});
check('a send returns SENT, not queued', otp.status === 'sent', JSON.stringify(otp));
check('the response carries a provider id', Boolean(otp.provider_id), JSON.stringify(otp.provider_id));
check('nothing has to be polled', otp.id !== undefined && otp.transport !== undefined, '');

// ── the origin gate ─────────────────────────────────────────────────────────
for (const [label, origin] of [
  ['a localhost origin is DROPPED', 'http://localhost:5173/quiz'],
  ['a Vercel preview origin is DROPPED', 'https://medquiz-git-feat-abc.vercel.app/'],
  ['a LAN origin is DROPPED', 'http://192.168.1.20:5173/'],
]) {
  const r = await post('/api/v1/notify', {
    event: 'medqize.owner.backend_error', to: `drop.${run}@example.com`,
    title: 'dev error', severity: 'HIGH', sourceOrigin: origin,
  });
  check(label, r.status === 'dropped', JSON.stringify(r));
}

// ── flood cooldown ──────────────────────────────────────────────────────────
const key = `smoke-err-${run}`;
const first = await post('/api/v1/notify', {
  event: 'medqize.owner.backend_error', to: `err.${run}@example.com`,
  title: 'DB connection refused', severity: 'HIGH', dedupeKey: key, sourceOrigin: PROD,
});
const second = await post('/api/v1/notify', {
  event: 'medqize.owner.backend_error', to: `err.${run}@example.com`,
  title: 'DB connection refused', severity: 'HIGH', dedupeKey: key, sourceOrigin: PROD,
});
check('the first error alert is sent', first.status === 'sent', JSON.stringify(first));
check('an identical repeat is THROTTLED, not sent again', second.status === 'throttled', JSON.stringify(second));
check('the repeat is counted', (second.occurrences ?? 0) > 1, `occurrences=${second.occurrences}`);

// ── idempotency ─────────────────────────────────────────────────────────────
const replay = await post('/api/v1/send', {
  event: 'medqize.otp.signup', to: `otp.${run}@example.com`,
  template: 'otp', data: { code: '4821' }, sourceOrigin: PROD,
  idempotencyKey: `smoke-otp-${run}`,
});
check('a replayed idempotency key does not re-send', replay.status === 'duplicate', JSON.stringify(replay));
check('the replay points at the original message', replay.id === otp.id, '');

// ── validation ──────────────────────────────────────────────────────────────
const bad = await post('/api/v1/send', { to: 'not-an-email', subject: 'x', text: 'x' });
check('an invalid recipient is refused', bad.http === 400, `status ${bad.http}`);

const huge = await post('/api/v1/send', {
  event: 'medqize.invoice', to: `big.${run}@example.com`, subject: 'Invoice', text: 'x',
  sourceOrigin: PROD,
  attachments: [{ filename: 'big.pdf', content: 'A'.repeat(3 * 1024 * 1024), content_type: 'application/pdf' }],
});
check('an oversized attachment is refused with 413', huge.http === 413, `status ${huge.http}`);

// ── bulk ────────────────────────────────────────────────────────────────────
const bulk = await post('/api/v1/send/bulk', {
  event: 'hr.branch.notify_all', subject: 'إشعار', text: 'body', sourceOrigin: PROD,
  recipients: [`b1.${run}@example.com`, `B1.${run}@EXAMPLE.COM`, `b2.${run}@example.com`],
});
check('bulk reports per-recipient outcomes', bulk.http === 200, `status ${bulk.http}`);
check('bulk deduplicates case-insensitively', (bulk.duplicate ?? 0) >= 1, JSON.stringify(bulk));
check('bulk actually sent the rest', (bulk.sent ?? 0) >= 2, JSON.stringify(bulk));

// ── quota is informational, never a refusal ─────────────────────────────────
const q = await get('/api/v1/quota');
check('quota reports the budget', typeof q.remaining === 'number', JSON.stringify(q.remaining));
check('quota says whether Resend is still carrying mail', typeof q.resend_available === 'boolean', '');
check('the project sees only its own limits', q.project?.slug !== undefined, JSON.stringify(q.project));

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
