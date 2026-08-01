/**
 * Connectivity check for every registered project.
 *
 *   npm run verify:projects
 *
 * Answers one question per project: is it wired to the gateway, and does each
 * of its events get the treatment it is supposed to get? Sends nothing — the
 * gateway is in DRY_RUN, and most of these assertions are about messages
 * deliberately NOT being sent.
 *
 * Keys come from PROJECT_KEYS in .env.local (slug=key,slug=key).
 */
import './_env.mjs';
import { required } from './_env.mjs';

const BASE = process.env.GATEWAY_URL ?? 'https://email-services-nu.vercel.app';
const KEYS = Object.fromEntries(
  (required('PROJECT_KEYS')).split(',').map((p) => p.trim().split('=')),
);

const PROD = {
  medqize: 'https://medquiz.vercel.app/',
  hr: 'https://hr-react-theta.vercel.app/',
  portfolio: 'https://alshraky.com/',
  game: 'https://te3rafni.vercel.app/',
};

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`    PASS  ${name}`); }
  else { failed++; console.log(`    FAIL  ${name}  ${detail}`); }
};

async function call(slug, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEYS[slug]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { http: res.status, ...(await res.json().catch(() => ({}))) };
}

const stamp = Date.now();

// slug -> [label, payload, expected status]
const MATRIX = {
  medqize: [
    ['OTP is P0 and goes out immediately', 'send',
      { event: 'medqize.otp.signup', to: `p1.${stamp}@example.com`, subject: 'رمز', text: '4821' }, ['sent', 'queued']],
    ['contact form folds into the owner digest', 'notify',
      { event: 'medqize.owner.contact_form', to: `owner.${stamp}@example.com`, title: 'Contact', summary: 'hi' }, ['buffered']],
    ['a CRITICAL error escapes the digest', 'notify',
      { event: 'medqize.owner.backend_error', to: `owner.${stamp}@example.com`, title: 'DOWN', severity: 'CRITICAL' }, ['sent', 'queued']],
    ['dev-origin error is dropped', 'notify',
      { event: 'medqize.owner.backend_error', to: `owner.${stamp}@example.com`, title: 'dev', severity: 'HIGH',
        sourceOrigin: 'http://localhost:5173/quiz' }, ['dropped']],
  ],
  hr: [
    ['branch login OTP is P0', 'send',
      { event: 'hr.otp.login', to: `p2.${stamp}@example.com`, subject: 'رمز', text: '1234' }, ['sent', 'queued']],
    ['new request folds into the owner digest', 'notify',
      { event: 'hr.owner.new_request', to: `owner.${stamp}@example.com`, title: 'طلب', summary: 'x' }, ['buffered']],
    ['branch fan-out is queued at P3, not sent inline', 'send',
      { event: 'hr.branch.notify_all', to: `p3.${stamp}@example.com`, subject: 'إشعار', text: 'x' }, ['queued']],
  ],
  portfolio: [
    ['contact form folds into the shared owner digest', 'notify',
      { event: 'portfolio.owner.contact_form', to: `owner.${stamp}@example.com`, title: 'New contact', summary: 'hi' }, ['buffered']],
    ['job digest stays immediate', 'send',
      { event: 'portfolio.owner.job_digest', to: `owner.${stamp}@example.com`, subject: 'jobs', html: '<p>x</p>' }, ['sent', 'queued']],
  ],
  game: [
    ['player feedback folds into the owner digest', 'notify',
      { event: 'game.owner.feedback', to: `owner.${stamp}@example.com`, title: 'رسالة', summary: 'x' }, ['buffered']],
  ],
};

console.log(`\n  Project connectivity — ${BASE}\n`);

for (const [slug, cases] of Object.entries(MATRIX)) {
  console.log(`  ${slug}`);
  if (!KEYS[slug]) { failed++; console.log(`    FAIL  no key configured`); continue; }

  for (const [label, endpoint, payload, expected] of cases) {
    const path = endpoint === 'notify' ? '/api/v1/notify' : '/api/v1/send';
    const body = { sourceOrigin: PROD[slug], ...payload };
    const r = await call(slug, path, body);
    check(label, expected.includes(r.status), `got ${r.status ?? r.error ?? r.http}`);
  }

  // Quota visibility: a project must be able to size its own batches.
  const q = await fetch(`${BASE}/api/v1/quota?priority=3`, { headers: { Authorization: `Bearer ${KEYS[slug]}` } })
    .then((r) => r.json()).catch(() => ({}));
  check('can read its own quota', typeof q.remaining_for_priority === 'number',
    JSON.stringify(q.error ?? q.remaining_for_priority));
  check('sees its own project limits only', q.project?.slug === slug, `reported ${q.project?.slug}`);
  console.log('');
}

// ── isolation: a key must not be usable for another project's events ────────
console.log('  isolation');
const cross = await call('game', '/api/v1/send', {
  event: 'medqize.otp.signup', to: `x.${stamp}@example.com`, subject: 'x', text: 'x',
  sourceOrigin: PROD.game,
});
// game's best_priority is 1, so even naming SQB's P0 event cannot buy P0.
check("game's key cannot obtain P0 by naming another project's event",
  cross.priority === undefined || cross.priority >= 1, `priority=${cross.priority}`);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
