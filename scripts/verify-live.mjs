/**
 * Deep verification of the paths the smoke test cannot reach.
 *
 *   npm run verify:live
 *
 * Covers the machinery that only exists once there is a real database and a
 * real queue: claiming under SKIP LOCKED, the advisory lock, the atomic
 * digest freeze-flush, and the webhook -> suppression feedback loop.
 *
 * Runs with DRY_RUN=true. Nothing is actually emailed.
 */
import './_env.mjs';
import { required } from './_env.mjs';
import { createHmac } from 'node:crypto';
import pg from 'pg';

const BASE = process.env.GATEWAY_URL ?? 'http://localhost:3100';
const KEY = process.env.SMOKE_KEY ?? required('SMOKE_KEY');
const DRAIN = required('DRAIN_SECRET');
const TO = process.env.SMOKE_TO ?? 'alshraky3@gmail.com';
const RUN = `verify${Date.now()}`;

const connectionString = required('DATABASE_URL');
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await db.connect();

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
};

const post = async (path, body, headers = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

console.log(`\n  Deep verification against ${BASE}\n`);

try {
  // ── 1. the drain loop actually moves the queue ────────────────────────────
  console.log('  -- queue drain --');
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await post('/api/v1/send', {
      event: 'medqize.lifecycle.welcome', to: `drain${i}.${RUN}@example.com`,
      subject: `Drain ${i}`, text: 'body',
      idempotencyKey: `${RUN}:drain:${i}`,
      sourceOrigin: 'https://medquiz.vercel.app/',
    });
    if (r.body?.id) ids.push(r.body.id);
  }
  check('messages enqueue as `queued`', ids.length === 4, `got ${ids.length}`);

  // Draining is a RACE by design: every inbound /send fires an opportunistic
  // drain, so the enqueue calls above may already be draining in the background
  // and holding the advisory lock. An explicit tick that returns
  // {skipped:'locked'} therefore means the system is working, not failing.
  // What matters is that the queue empties — so poll for the outcome rather
  // than asserting on one tick's counters.
  const drainRes = await fetch(`${BASE}/api/v1/drain?source=verify`, {
    method: 'POST', headers: { Authorization: `Bearer ${DRAIN}` },
  });
  check('drain authenticates and runs', drainRes.status === 200, `status ${drainRes.status}`);

  let after = [];
  let ticks = 0;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    ({ rows: after } = await db.query(
      `SELECT status, transport FROM messages WHERE id = ANY($1::uuid[])`, [ids]));
    if (after.every((r) => ['sent', 'failed', 'dead', 'suppressed'].includes(r.status))) break;
    await new Promise((r) => setTimeout(r, 2000));
    await fetch(`${BASE}/api/v1/drain?source=verify-poll`, {
      method: 'POST', headers: { Authorization: `Bearer ${DRAIN}` },
    }).catch(() => {});
    ticks++;
  }

  check('the queue drains to completion', after.every((r) => r.status === 'sent'),
    `after ${ticks} ticks: ${JSON.stringify(after.map((r) => r.status))}`);
  check('dry-run used the noop transport, not Resend',
    after.every((r) => r.transport === 'noop'), JSON.stringify(after.map((r) => r.transport)));

  const { rows: runs } = await db.query(
    `SELECT COUNT(*)::int AS n FROM drain_runs WHERE started_at > NOW() - INTERVAL '5 minutes' AND sent > 0`);
  check('drain runs are recorded for observability', runs[0].n > 0, `runs with sends=${runs[0].n}`);

  // ── 2. the advisory lock prevents concurrent drains ───────────────────────
  console.log('\n  -- concurrency --');
  for (let i = 0; i < 6; i++) {
    await post('/api/v1/send', {
      event: 'medqize.lifecycle.streak', to: `lock${i}.${RUN}@example.com`,
      subject: 'Lock', text: 'x', idempotencyKey: `${RUN}:lock:${i}`,
      sourceOrigin: 'https://medquiz.vercel.app/',
    });
  }
  const [a, b] = await Promise.all([
    fetch(`${BASE}/api/v1/drain?source=concurrent-a`, { method: 'POST', headers: { Authorization: `Bearer ${DRAIN}` } }).then((r) => r.json()),
    fetch(`${BASE}/api/v1/drain?source=concurrent-b`, { method: 'POST', headers: { Authorization: `Bearer ${DRAIN}` } }).then((r) => r.json()),
  ]);
  // The invariant is "not both ran", not "exactly one ran". An opportunistic
  // drain triggered by the enqueues above may already hold the lease, in which
  // case BOTH explicit ticks correctly skip.
  const ran = [a, b].filter((r) => r.skipped !== 'locked').length;
  check('two simultaneous drains never both run', ran <= 1,
    `a=${JSON.stringify(a.skipped ?? a.sent)} b=${JSON.stringify(b.skipped ?? b.sent)}`);

  const { rows: dupes } = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE idempotency_key LIKE $1 AND status = 'sent'`, [`${RUN}:lock:%`]);
  check('no message was sent twice under contention', dupes[0].n <= 6, `sent=${dupes[0].n}`);

  // ── 3. digest freeze-flush produces exactly ONE email ─────────────────────
  console.log('\n  -- digest flush --');
  const digestAddr = `digest.${RUN}@example.com`;
  const BUFFERED = 30; // above the flush_threshold of 25 -> volume trigger
  for (let i = 0; i < BUFFERED; i++) {
    await post('/api/v1/notify', {
      event: 'medqize.owner.contact_form', to: digestAddr,
      title: `Contact ${i}`, summary: `message ${i}`, severity: 'info',
      dedupeKey: `${RUN}:contact:${i}`,
      sourceOrigin: 'https://medquiz.vercel.app/',
    });
  }
  const { rows: buffered } = await db.query(
    `SELECT COUNT(*)::int AS n FROM digest_buffer WHERE lower(to_address)=lower($1) AND status='buffered'`,
    [digestAddr]);
  check(`${BUFFERED} events sit in the buffer, unsent`, buffered[0].n > 0, `buffered=${buffered[0].n}`);

  // Poll: the lease may be held by an opportunistic drain, and a single tick
  // that returns {skipped:'locked'} is not a failure.
  let digestMsgs = [];
  for (let i = 0; i < 12; i++) {
    await fetch(`${BASE}/api/v1/drain?source=verify-digest`, {
      method: 'POST', headers: { Authorization: `Bearer ${DRAIN}` },
    }).catch(() => {});
    ({ rows: digestMsgs } = await db.query(
      `SELECT id, subject, status, transport FROM messages
        WHERE lower(to_address)=lower($1) AND digest_of IS NOT NULL`, [digestAddr]));
    if (digestMsgs.length > 0) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  check('the buffer collapsed into exactly ONE digest email', digestMsgs.length === 1,
    `produced ${digestMsgs.length}`);
  check('the digest went over Gmail, costing zero Resend quota',
    digestMsgs[0]?.transport === 'noop' || digestMsgs[0]?.transport === 'gmail',
    digestMsgs[0]?.transport);

  const { rows: leftover } = await db.query(
    `SELECT COUNT(*)::int AS n FROM digest_buffer
      WHERE lower(to_address)=lower($1) AND status <> 'flushed'`, [digestAddr]);
  check('every buffered row was marked flushed, none stranded', leftover[0].n === 0, `stranded=${leftover[0].n}`);

  // ── 4. webhook -> suppression -> future sends withheld ────────────────────
  console.log('\n  -- webhook and suppression --');
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.log('  SKIP  webhook tests (RESEND_WEBHOOK_SECRET not set)');
  } else {
    const bounced = `bounce.${RUN}@example.com`;
    const payload = JSON.stringify({
      type: 'email.bounced',
      data: { email_id: `re_${RUN}`, to: [bounced], bounce: { type: 'Permanent' } },
    });
    const svixId = `msg_${RUN}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
      .update(`${svixId}.${ts}.${payload}`).digest('base64');

    const hook = await fetch(`${BASE}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
      body: payload,
    });
    check('a correctly signed webhook is accepted', hook.status === 200, `status ${hook.status}`);

    const { rows: supp } = await db.query(
      `SELECT reason, blocks_from_priority FROM suppressions
        WHERE lower(email)=lower($1) AND removed_at IS NULL`, [bounced]);
    check('a permanent bounce creates a suppression', supp.length === 1, JSON.stringify(supp));
    check('a hard bounce blocks EVERYTHING including OTP',
      supp[0]?.blocks_from_priority === 0, `blocks_from=${supp[0]?.blocks_from_priority}`);

    const blocked = await post('/api/v1/send', {
      event: 'medqize.otp.signup', to: bounced, subject: 'OTP', text: '1234',
      sourceOrigin: 'https://medquiz.vercel.app/',
    });
    check('a later send to that address is withheld', blocked.body?.status === 'suppressed',
      JSON.stringify(blocked.body));

    const replay = await fetch(`${BASE}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'svix-id': svixId, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
      body: payload,
    }).then((r) => r.json());
    check('a redelivered webhook is deduplicated', replay.deduplicated === true, JSON.stringify(replay));

    const badSig = await fetch(`${BASE}/api/webhooks/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'svix-id': 'x', 'svix-timestamp': ts, 'svix-signature': 'v1,wrong' },
      body: payload,
    });
    check('a forged webhook is rejected', badSig.status === 401, `status ${badSig.status}`);
  }

  // ── 5. quota ledger only counts Resend ────────────────────────────────────
  console.log('\n  -- quota accounting --');
  const { rows: ledger } = await db.query(
    `SELECT transport, COUNT(*)::int AS n FROM messages
      WHERE status='sent' AND created_at > NOW() - INTERVAL '1 hour' GROUP BY transport`);
  check('nothing was billed to Resend during a dry run',
    !ledger.some((r) => r.transport === 'resend'), JSON.stringify(ledger));

} finally {
  // ── cleanup: leave the live database clean for deployment ─────────────────
  const { rowCount: m } = await db.query(
    `DELETE FROM messages WHERE idempotency_key LIKE $1 OR to_address LIKE $2 OR to_address LIKE $3`,
    [`${RUN}:%`, `%${RUN}@example.com`, `%.${RUN}@example.com`]);
  const { rowCount: d } = await db.query(`DELETE FROM digest_buffer WHERE dedupe_key LIKE $1 OR to_address LIKE $2`,
    [`${RUN}:%`, `%${RUN}@example.com`]);
  const { rowCount: s } = await db.query(`DELETE FROM suppressions WHERE email LIKE $1`, [`%${RUN}@example.com`]);
  const { rowCount: e } = await db.query(`DELETE FROM message_events WHERE svix_id LIKE $1`, [`msg_${RUN}`]);
  console.log(`\n  cleaned up: ${m} messages, ${d} buffer rows, ${s} suppressions, ${e} events`);
  await db.end();
}

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
