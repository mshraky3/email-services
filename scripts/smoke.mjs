/**
 * End-to-end smoke test against a running gateway + real database.
 *
 *   npm run db:init && npm run db:seed
 *   npm run dev            # in another terminal
 *   GATEWAY_URL=http://localhost:3100 SMOKE_KEY=ek_live_medqize_... npm run smoke
 *
 * Everything runs with DRY_RUN=true, so no email leaves the building. What is
 * being proven is the DECISION each message gets, which is the part that can
 * actually lose mail or blow the quota.
 */
import './_env.mjs';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:3100';
const KEY = process.env.SMOKE_KEY;
const TO = process.env.SMOKE_TO ?? 'alshraky3@gmail.com';

if (!KEY) {
  console.error('\n  SMOKE_KEY is required — take it from `npm run db:seed` output.\n');
  process.exit(1);
}

let passed = 0, failed = 0;

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}

async function post(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

console.log(`\n  Gateway: ${BASE}\n`);

// ── 1. health ───────────────────────────────────────────────────────────────
const health = await get('/api/v1/health');
check('health responds', health.status === 200 || health.status === 503, `status ${health.status}`);
check('dry-run is on (nothing will actually send)', health.body?.dry_run === true,
  'set DRY_RUN=true before smoke testing');

// ── 2. auth ─────────────────────────────────────────────────────────────────
const noAuth = await fetch(`${BASE}/api/v1/send`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ to: TO, subject: 'x', text: 'x' }),
});
check('unauthenticated send is rejected', noAuth.status === 401, `got ${noAuth.status}`);

// ── 3. the origin gate — the localhost-against-prod case ────────────────────
const dev = await post('/api/v1/send', {
  event: 'medqize.owner.backend_error', to: TO, subject: 'dev error', text: 'stack trace',
  sourceOrigin: 'http://localhost:5173/quiz',
});
check('a localhost origin is DROPPED, not sent', dev.body?.status === 'dropped',
  JSON.stringify(dev.body));
check('the drop costs no quota', dev.body?.id === undefined || dev.body?.id === null, '');

const preview = await post('/api/v1/send', {
  event: 'medqize.owner.backend_error', to: TO, subject: 'preview error', text: 'x',
  sourceOrigin: 'https://medquiz-git-feat-abc.vercel.app/',
});
check('a Vercel preview origin is DROPPED', preview.body?.status === 'dropped', JSON.stringify(preview.body));

// ── 4. digest collapse ──────────────────────────────────────────────────────
const before = await get('/api/v1/quota');
const errKey = `SMOKE_${Date.now()}`;
for (let i = 0; i < 20; i++) {
  await post('/api/v1/notify', {
    event: 'medqize.owner.backend_error',
    to: TO,
    title: 'DB connection refused',
    summary: 'ECONNREFUSED 10.0.0.5:5432',
    severity: 'HIGH',
    dedupeKey: errKey,
    data: { error_key: errKey },
    sourceOrigin: 'https://medquiz.vercel.app/',
  });
}
const bufferRes = await post('/api/v1/notify', {
  event: 'medqize.owner.backend_error', to: TO, title: 'DB connection refused',
  severity: 'HIGH', dedupeKey: errKey, data: { error_key: errKey },
  sourceOrigin: 'https://medquiz.vercel.app/',
});
check('repeated errors are BUFFERED, not sent one by one', bufferRes.body?.status === 'buffered',
  JSON.stringify(bufferRes.body));
check('repeats increment a counter rather than creating rows',
  (bufferRes.body?.occurrences ?? 0) > 1, `occurrences=${bufferRes.body?.occurrences}`);

// ── 5. escalation ───────────────────────────────────────────────────────────
const critical = await post('/api/v1/notify', {
  event: 'medqize.owner.backend_error', to: TO, title: 'PRODUCTION DOWN',
  severity: 'CRITICAL', data: { error_key: `${errKey}_crit` },
  sourceOrigin: 'https://medquiz.vercel.app/',
});
check('CRITICAL escalates out of the digest', critical.body?.status !== 'buffered',
  JSON.stringify(critical.body));

// ── 6. idempotency ──────────────────────────────────────────────────────────
const idem = `smoke-${Date.now()}`;
const first = await post('/api/v1/send', {
  event: 'medqize.lifecycle.welcome', to: TO, subject: 'Welcome', text: 'hi',
  idempotencyKey: idem, sourceOrigin: 'https://medquiz.vercel.app/',
});
const replay = await post('/api/v1/send', {
  event: 'medqize.lifecycle.welcome', to: TO, subject: 'Welcome', text: 'hi',
  idempotencyKey: idem, sourceOrigin: 'https://medquiz.vercel.app/',
});
check('first send is accepted', ['queued', 'sent'].includes(first.body?.status), JSON.stringify(first.body));
check('a replay returns the ORIGINAL and does not re-send', replay.body?.status === 'duplicate',
  JSON.stringify(replay.body));
check('the replay points at the same message', replay.body?.id === first.body?.id, '');

// ── 7. owner mail costs zero Resend quota ───────────────────────────────────
const after = await get('/api/v1/quota');
check('owner-facing traffic did not consume the Resend budget',
  after.body?.daily_used === before.body?.daily_used,
  `before=${before.body?.daily_used} after=${after.body?.daily_used}`);

// ── 8. quota reporting ──────────────────────────────────────────────────────
const q = await get('/api/v1/quota?priority=3');
check('quota reports a remaining figure crons can size against',
  typeof q.body?.remaining_for_priority === 'number', JSON.stringify(q.body?.remaining_for_priority));
check('P0 reserve is protected', (q.body?.by_priority?.[0]?.reserve ?? 0) > 0, '');

// ── 9. bulk ─────────────────────────────────────────────────────────────────
const bulk = await post('/api/v1/send/bulk', {
  event: 'medqize.broadcast.campaign',
  subject: 'Smoke broadcast', text: 'body', priority: 4,
  recipients: [TO, TO.toUpperCase(), 'smoke2@example.com'],
  sourceOrigin: 'https://medquiz.vercel.app/',
});
check('bulk returns 202 immediately', bulk.status === 202, `status ${bulk.status}`);
check('bulk deduplicates case-insensitively', (bulk.body?.duplicate ?? 0) >= 1, JSON.stringify(bulk.body));
check('bulk reports an honest schedule', typeof bulk.body?.scheduled_over === 'string', '');

// ── 10. validation ──────────────────────────────────────────────────────────
const bad = await post('/api/v1/send', { to: 'not-an-email', subject: 'x', text: 'x' });
check('an invalid recipient is refused', bad.status === 400, `status ${bad.status}`);

const huge = await post('/api/v1/send', {
  event: 'medqize.invoice', to: TO, subject: 'Invoice', text: 'x',
  attachments: [{ filename: 'big.pdf', content: 'A'.repeat(3 * 1024 * 1024), content_type: 'application/pdf' }],
  sourceOrigin: 'https://medquiz.vercel.app/',
});
check('an oversized attachment is refused with 413', huge.status === 413, `status ${huge.status}`);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
