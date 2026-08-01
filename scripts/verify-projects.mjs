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
    ['OTP sends immediately', 'send',
      { event: 'medqize.otp.signup', to: `p1.${stamp}@example.com`, subject: 'رمز', text: '4821' }, ['sent']],
    ['contact form sends immediately', 'notify',
      { event: 'medqize.owner.contact_form', to: `owner.${stamp}@example.com`, title: 'Contact', summary: 'hi' }, ['sent']],
    ['an error alert sends', 'notify',
      { event: 'medqize.owner.backend_error', to: `owner.${stamp}@example.com`, title: 'DOWN',
        severity: 'CRITICAL', dedupeKey: `crit-${stamp}` }, ['sent']],
    ['an identical error repeat is throttled', 'notify',
      { event: 'medqize.owner.backend_error', to: `owner.${stamp}@example.com`, title: 'DOWN',
        severity: 'CRITICAL', dedupeKey: `crit-${stamp}` }, ['throttled']],
    ['dev-origin mail is dropped', 'notify',
      { event: 'medqize.owner.backend_error', to: `owner.${stamp}@example.com`, title: 'dev', severity: 'HIGH',
        sourceOrigin: 'http://localhost:5173/quiz' }, ['dropped']],
  ],
  hr: [
    ['branch login OTP sends immediately', 'send',
      { event: 'hr.otp.login', to: `p2.${stamp}@example.com`, subject: 'رمز', text: '1234' }, ['sent']],
    ['new request sends immediately', 'notify',
      { event: 'hr.owner.new_request', to: `owner.${stamp}@example.com`, title: 'طلب', summary: 'x' }, ['sent']],
    ['branch fan-out sends', 'send',
      { event: 'hr.branch.notify_all', to: `p3.${stamp}@example.com`, subject: 'إشعار', text: 'x' }, ['sent']],
  ],
  portfolio: [
    ['contact form sends immediately', 'notify',
      { event: 'portfolio.owner.contact_form', to: `owner.${stamp}@example.com`, title: 'New contact', summary: 'hi' }, ['sent']],
    ['job digest sends', 'send',
      { event: 'portfolio.owner.job_digest', to: `owner.${stamp}@example.com`, subject: 'jobs', html: '<p>x</p>' }, ['sent']],
  ],
  game: [
    ['player feedback sends immediately', 'notify',
      { event: 'game.owner.feedback', to: `owner.${stamp}@example.com`, title: 'رسالة', summary: 'x' }, ['sent']],
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

  const q = await fetch(`${BASE}/api/v1/quota`, { headers: { Authorization: `Bearer ${KEYS[slug]}` } })
    .then((r) => r.json()).catch(() => ({}));
  check('can read its own quota', typeof q.remaining === 'number', JSON.stringify(q.error ?? q.remaining));
  check('sees its own project limits only', q.project?.slug === slug, `reported ${q.project?.slug}`);
  console.log('');
}

// ── isolation ───────────────────────────────────────────────────────────────
console.log('  isolation');
const mine = await fetch(`${BASE}/api/v1/quota`, { headers: { Authorization: `Bearer ${KEYS.game}` } })
  .then((r) => r.json());
check("a project's quota view is scoped to itself", mine.project?.slug === 'game', JSON.stringify(mine.project?.slug));

const stolen = await fetch(`${BASE}/api/v1/send`, {
  method: 'POST',
  headers: { Authorization: 'Bearer ek_live_medqize_not-a-real-key', 'Content-Type': 'application/json' },
  body: JSON.stringify({ to: `x.${stamp}@example.com`, subject: 'x', text: 'x' }),
});
check('a forged key is rejected', stolen.status === 401, `got ${stolen.status}`);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
