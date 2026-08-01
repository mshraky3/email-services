/**
 * Deploy readiness check.
 *
 *   npm run preflight
 *
 * Proves every credential and dependency actually works WITHOUT sending a
 * single email or spending any quota:
 *   - Resend key is validated against the read-only GET /domains endpoint,
 *     which also confirms the sending domain is verified.
 *   - Gmail is validated with an SMTP handshake (nodemailer verify), which
 *     authenticates and disconnects without a message.
 *   - Postgres is checked for reachability and schema completeness.
 *
 * Run this before every deploy, and again against production once deployed.
 */
import './_env.mjs';
import pg from 'pg';
import nodemailer from 'nodemailer';

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  ✓  ${label}${detail ? '  ' + detail : ''}`);
const bad = (label, detail = '') => { failures++; console.log(`  ✗  ${label}${detail ? '  ' + detail : ''}`); };
const warn = (label, detail = '') => { warnings++; console.log(`  !  ${label}${detail ? '  ' + detail : ''}`); };

console.log('\n  PREFLIGHT\n');

// ── environment ─────────────────────────────────────────────────────────────
console.log('  environment');
const REQUIRED = ['DATABASE_URL', 'MAIL_DOMAIN', 'ADMIN_KEY', 'DRAIN_SECRET', 'UNSUB_SECRET'];
for (const k of REQUIRED) {
  if (process.env[k]) ok(k); else bad(k, 'missing');
}
for (const k of ['RESEND_API_KEY', 'RESEND_WEBHOOK_SECRET', 'GMAIL_SMTP_USER', 'GMAIL_SMTP_PASS', 'PUBLIC_BASE_URL', 'PRODUCTION_ORIGINS']) {
  if (process.env[k]) ok(k); else warn(k, 'not set');
}

const dryRun = process.env.DRY_RUN === 'true';
if (dryRun) warn('DRY_RUN=true', 'nothing will actually send — correct for shadow, flip to false to go live');
else ok('DRY_RUN=false', 'the gateway WILL send real email');

for (const secret of ['ADMIN_KEY', 'DRAIN_SECRET', 'UNSUB_SECRET']) {
  const v = process.env[secret] ?? '';
  if (v && v.length < 20) bad(`${secret} is too short`, `${v.length} chars — use at least 20`);
}

// ── database ────────────────────────────────────────────────────────────────
console.log('\n  database');
const EXPECTED_TABLES = [
  'projects', 'api_keys', 'notification_policies', 'quota_policy', 'quota_settings',
  'messages', 'message_attachments', 'message_events', 'suppressions', 'soft_bounces',
  'digest_buffer', 'drain_runs', 'schema_meta',
];
if (process.env.DATABASE_URL) {
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const t0 = Date.now();
    await db.connect();
    ok('connected', `${Date.now() - t0}ms`);

    const { rows: tables } = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const present = new Set(tables.map((r) => r.table_name));
    const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
    if (missing.length === 0) ok(`all ${EXPECTED_TABLES.length} tables present`);
    else bad('missing tables', missing.join(', ') + ' — run npm run db:init');

    const { rows: projects } = await db.query(
      `SELECT p.slug, p.dry_run, COUNT(n.id)::int AS events,
              (SELECT COUNT(*)::int FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL) AS keys
         FROM projects p LEFT JOIN notification_policies n ON n.project_id=p.id
        GROUP BY p.id, p.slug, p.dry_run ORDER BY p.slug`);
    if (projects.length === 0) bad('no projects registered', 'run npm run db:seed');
    else {
      ok(`${projects.length} projects registered`);
      for (const p of projects) {
        const issues = [];
        if (p.keys === 0) issues.push('NO API KEY');
        if (p.events === 0) issues.push('no event policies');
        const label = `    ${p.slug.padEnd(11)} ${String(p.events).padStart(2)} events, ${p.keys} key(s)${p.dry_run ? ', dry_run' : ''}`;
        if (issues.length) bad(label, issues.join(' + ')); else ok(label);
      }
    }

    // The bug that would silently starve every low-priority class.
    const { rows: qp } = await db.query(`SELECT COALESCE(SUM(reserve),0)::int AS total FROM quota_policy`);
    const { rows: qs } = await db.query(`SELECT v FROM quota_settings WHERE k='daily_ceiling'`);
    const ceiling = Number(qs[0]?.v ?? 95);
    const reserves = qp[0].total;
    if (reserves > ceiling * 0.8) {
      warn('reserves exceed 80% of daily_ceiling',
        `${reserves} vs ${ceiling} — they are auto-scaled down, but consider lowering them explicitly`);
    } else ok('reserves fit the daily budget', `${reserves} reserved of ${ceiling}`);

    const { rows: stuck } = await db.query(
      `SELECT COUNT(*)::int AS n FROM messages
        WHERE status IN ('claimed','attempting') AND claimed_at < NOW() - INTERVAL '15 minutes'`);
    if (stuck[0].n > 0) warn('messages stuck in flight', `${stuck[0].n} — the next drain will reclaim them`);
    else ok('no stuck messages');

    const { rows: dead } = await db.query(`SELECT COUNT(*)::int AS n FROM messages WHERE status='dead'`);
    if (dead[0].n > 0) warn('dead-lettered messages', `${dead[0].n} — inspect on the dashboard`);
    else ok('no dead letters');
  } catch (err) {
    bad('database', err.message);
  } finally {
    await db.end().catch(() => {});
  }
}

// ── Resend (read-only: no send, no quota) ───────────────────────────────────
console.log('\n  resend');
if (!process.env.RESEND_API_KEY) {
  warn('RESEND_API_KEY not set', 'user-facing mail cannot be sent');
} else {
  try {
    const res = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    });
    if (res.status === 401 || res.status === 403) {
      bad('API key rejected', `HTTP ${res.status} — the key is invalid or revoked`);
    } else if (!res.ok) {
      warn('could not list domains', `HTTP ${res.status}`);
    } else {
      ok('API key is valid');
      const body = await res.json();
      const domains = body?.data ?? [];
      const want = process.env.MAIL_DOMAIN;
      const match = domains.find((d) => d.name === want);
      if (!match) {
        bad(`${want} is not on this Resend account`, `found: ${domains.map((d) => d.name).join(', ') || 'none'}`);
      } else if (match.status !== 'verified') {
        bad(`${want} is not verified`, `status: ${match.status} — mail will not be delivered`);
      } else {
        ok(`${want} is verified`, `region ${match.region ?? 'n/a'}`);
      }
      if (domains.length > 1) warn('more than one domain on a free plan', 'unexpected — check the account');
    }
  } catch (err) {
    bad('could not reach api.resend.com', err.message);
  }
}

// ── Gmail (SMTP handshake only: authenticates, sends nothing) ───────────────
console.log('\n  gmail  (carries owner mail at zero Resend cost)');
if (!process.env.GMAIL_SMTP_USER || !process.env.GMAIL_SMTP_PASS) {
  warn('Gmail not configured', 'owner mail would fall back to Resend and consume the shared budget');
} else {
  const pass = process.env.GMAIL_SMTP_PASS.replace(/\s/g, '');
  if (pass.length !== 16) warn('GMAIL_SMTP_PASS is not 16 characters', 'expected a Gmail App Password');
  try {
    const t = nodemailer.createTransport({
      host: 'smtp.gmail.com', port: 587, secure: false,
      auth: { user: process.env.GMAIL_SMTP_USER, pass },
      connectionTimeout: 15_000, greetingTimeout: 15_000,
    });
    await t.verify();
    ok('SMTP authenticated', process.env.GMAIL_SMTP_USER.replace(/^(.{3}).*(@.*)$/, '$1***$2'));
    t.close();
  } catch (err) {
    const code = err.responseCode ?? '';
    if (code === 534 || code === 535) {
      bad('Gmail rejected authentication', `${code} — App Password wrong, or the sending IP is blocked`);
    } else {
      bad('Gmail SMTP', err.message);
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n  ' + '-'.repeat(60));
if (failures === 0) {
  console.log(`  READY${warnings ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}`);
  if (dryRun) console.log('  Still in DRY_RUN. Set DRY_RUN=false when you want real sends.');
} else {
  console.log(`  NOT READY — ${failures} blocking issue${failures === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
}
console.log('');
process.exit(failures === 0 ? 0 : 1);
