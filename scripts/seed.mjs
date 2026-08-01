/**
 * Register the four projects and every one of their 46 email types.
 *
 *   npm run db:seed
 *
 * This file IS the migration inventory. Each row was taken from reading the
 * projects' source, and the priority/audience/delivery_mode columns encode the
 * decisions that make 100 emails/day survivable:
 *
 *   - audience 'owner'  -> routed to Gmail, costs ZERO Resend quota
 *   - delivery_mode 'digest:*' -> collapsed into 2 emails/day
 *   - escalate_when     -> CRITICAL still arrives instantly
 *
 * Re-running is safe: projects and policies upsert, and API keys are only
 * minted for projects that do not have one yet.
 */
import './_env.mjs';
import { required } from './_env.mjs';
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';

const connectionString = required('DATABASE_URL');
const client = new pg.Client({
  connectionString,
  ssl: connectionString.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
});

// ── projects ────────────────────────────────────────────────────────────────
// One verified domain (Resend free = 1), so identity is the local part.
const PROJECTS = [
  { slug: 'medqize',   display_name: 'SQB',        from_local_part: 'noreply',  default_from_name: 'SQB',        locale: 'ar', dir: 'rtl', best_priority: 0, daily_max: 60 },
  { slug: 'hr',        display_name: 'HR system',  from_local_part: 'hr',       default_from_name: 'HR system',  locale: 'ar', dir: 'rtl', best_priority: 0, daily_max: 50 },
  { slug: 'portfolio', display_name: 'Portfolio',  from_local_part: 'contact',  default_from_name: 'Alshraky',   locale: 'en', dir: 'ltr', best_priority: 1, daily_max: 20 },
  { slug: 'game',      display_name: 'Te3rafni',   from_local_part: 'play',     default_from_name: 'تعرفني',     locale: 'ar', dir: 'rtl', best_priority: 1, daily_max: 20 },
];

const OWNER_DAILY  = 'owner:daily';
const OWNER_HOURLY = 'owner:hourly';
const CRITICAL_ONLY = { severity: ['CRITICAL', 'critical'] };

// priority, audience, mode, digest key, dedupe key, escalate, escalated priority, transport, honors unsub
const P = (event_type, priority, audience, delivery_mode, opts = {}) => ({
  event_type, priority, audience, delivery_mode,
  digest_key_template: opts.digest ?? null,
  dedupe_key_template: opts.dedupe ?? null,
  flush_threshold: opts.threshold ?? 25,
  escalate_when: opts.escalate ?? null,
  escalated_priority: opts.escalatedPriority ?? null,
  transport_hint: opts.transport ?? null,
  ttl_seconds: opts.ttl ?? null,
  honors_unsubscribe: opts.honorsUnsub ?? true,
});

const POLICIES = {
  // ── MEDQIZE / SQB — 22 types ──────────────────────────────────────────────
  medqize: [
    // P0: a human is staring at a blocked screen.
    P('medqize.otp.signup', 0, 'user', 'immediate', { honorsUnsub: false }),
    P('medqize.otp.reset',  0, 'user', 'immediate', { honorsUnsub: false }),

    // P1: the user is expecting it. Invoice carries a PDF.
    P('medqize.invoice',                    1, 'user', 'immediate', { honorsUnsub: false }),
    P('medqize.question_report.corrected',  1, 'user', 'immediate'),
    P('medqize.question_report.confirmed',  1, 'user', 'immediate'),

    // P2 owner-facing: Gmail transport + daily digest. This block is the single
    // biggest quota recovery in the whole system.
    P('medqize.owner.admin_account_created', 2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('medqize.owner.temp_link_account',     2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('medqize.owner.contact_form',          2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('medqize.owner.suggestion',            2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('medqize.owner.question_report_filed', 2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('medqize.owner.test_email',            2, 'owner', 'immediate',     { transport: 'gmail' }),
    // Money arriving is worth an interruption.
    P('medqize.owner.payment_received',      2, 'owner', 'digest:hourly', { digest: OWNER_HOURLY, transport: 'gmail' }),
    // Has a PDF attachment, so it cannot be merged into a digest body.
    P('medqize.owner.subscriptions_report',  2, 'owner', 'immediate',     { transport: 'gmail' }),
    // Repeats increment instead of re-sending: "DB connection refused x47".
    P('medqize.owner.backend_error',         2, 'owner', 'digest:hourly', {
      digest: OWNER_HOURLY, dedupe: '{{data.error_key}}', threshold: 25,
      escalate: CRITICAL_ONLY, escalatedPriority: 1, transport: 'gmail',
    }),

    // P3 lifecycle: perishable. A 3-day-late welcome is worse than none.
    P('medqize.lifecycle.welcome',    3, 'user', 'immediate'),
    P('medqize.lifecycle.inactivity', 3, 'user', 'immediate'),
    P('medqize.lifecycle.streak',     3, 'user', 'immediate'),
    P('medqize.lifecycle.feedback',   3, 'user', 'immediate'),

    // P4 bulk.
    P('medqize.broadcast.campaign',   4, 'user',  'immediate'),
    P('medqize.broadcast.test',       4, 'owner', 'immediate', { transport: 'gmail' }),
    P('medqize.campaign.free_era',    4, 'user',  'immediate'),
    P('medqize.campaign.free_era_preview', 4, 'owner', 'immediate', { transport: 'gmail' }),
  ],

  // ── HR- — 19 types ────────────────────────────────────────────────────────
  hr: [
    // Branch accounts log in with OTP. If this class overruns its reserve, the
    // fix is longer sessions in HR-, not a bigger reserve here.
    P('hr.otp.login', 0, 'user', 'immediate', { honorsUnsub: false }),

    P('hr.request.answered_user',   1, 'user', 'immediate'),
    P('hr.request.answered_branch', 1, 'user', 'immediate'),
    P('hr.suggestion.updated',      1, 'user', 'immediate'),

    P('hr.owner.daily_critical_stats', 2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.expiry_summary',       2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.notification_created', 2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.branch_replied',       2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.new_request',          2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.new_suggestion',       2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.email_update_request', 2, 'owner', 'digest:daily',  { digest: OWNER_DAILY,  transport: 'gmail' }),
    P('hr.owner.test_email',           2, 'owner', 'immediate',     { transport: 'gmail' }),
    P('hr.owner.system_error',         2, 'owner', 'digest:hourly', {
      digest: OWNER_HOURLY, dedupe: '{{data.error_key}}',
      escalate: CRITICAL_ONLY, escalatedPriority: 1, transport: 'gmail',
    }),

    // The six fan-out loops. Each is O(branches) per admin action and is the
    // main reason /send/bulk exists.
    P('hr.branch.daily_expiry',    3, 'user', 'immediate'),
    P('hr.branch.manual_expiry',   3, 'user', 'immediate'),
    P('hr.branch.notify_all',      3, 'user', 'immediate'),
    P('hr.branch.payroll_reopened', 3, 'user', 'immediate'),
    P('hr.branch.new_academic_year', 3, 'user', 'immediate'),
    P('hr.branch.new_term',        3, 'user', 'immediate'),
  ],

  // ── portfolio — 5 types, ALL owner-facing, ALL on Gmail => 0 Resend quota ──
  portfolio: [
    P('portfolio.owner.contact_form',    2, 'owner', 'digest:daily', { digest: OWNER_DAILY, transport: 'gmail' }),
    P('portfolio.owner.resume_download', 2, 'owner', 'digest:daily', {
      digest: OWNER_DAILY, dedupe: 'portfolio.resume', transport: 'gmail',
    }),
    P('portfolio.owner.job_digest',      2, 'owner', 'immediate', { transport: 'gmail' }),
    P('portfolio.owner.evening_checkin', 2, 'owner', 'immediate', { transport: 'gmail' }),
    P('portfolio.owner.email_jobs',      1, 'owner', 'immediate', { transport: 'gmail' }),
  ],

  // ── game — greenfield, Tier C templates only ──────────────────────────────
  game: [
    P('game.owner.feedback', 2, 'owner', 'digest:daily', { digest: OWNER_DAILY, transport: 'gmail' }),
  ],
};

await client.connect();
try {
  const issued = [];

  for (const p of PROJECTS) {
    const { rows } = await client.query(
      `INSERT INTO projects (slug, display_name, from_local_part, default_from_name,
                             default_locale, default_dir, best_priority, daily_max)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (slug) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         from_local_part=EXCLUDED.from_local_part,
         default_from_name=EXCLUDED.default_from_name,
         default_locale=EXCLUDED.default_locale,
         default_dir=EXCLUDED.default_dir,
         best_priority=EXCLUDED.best_priority,
         daily_max=EXCLUDED.daily_max
       RETURNING id`,
      [p.slug, p.display_name, p.from_local_part, p.default_from_name, p.locale, p.dir, p.best_priority, p.daily_max],
    );
    const projectId = rows[0].id;

    for (const pol of POLICIES[p.slug] ?? []) {
      await client.query(
        `INSERT INTO notification_policies
           (project_id, event_type, priority, audience, delivery_mode, digest_key_template,
            dedupe_key_template, flush_threshold, escalate_when, escalated_priority,
            transport_hint, ttl_seconds, honors_unsubscribe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (project_id, event_type) DO UPDATE SET
           priority=EXCLUDED.priority, audience=EXCLUDED.audience,
           delivery_mode=EXCLUDED.delivery_mode, digest_key_template=EXCLUDED.digest_key_template,
           dedupe_key_template=EXCLUDED.dedupe_key_template, flush_threshold=EXCLUDED.flush_threshold,
           escalate_when=EXCLUDED.escalate_when, escalated_priority=EXCLUDED.escalated_priority,
           transport_hint=EXCLUDED.transport_hint, ttl_seconds=EXCLUDED.ttl_seconds,
           honors_unsubscribe=EXCLUDED.honors_unsubscribe`,
        [projectId, pol.event_type, pol.priority, pol.audience, pol.delivery_mode,
         pol.digest_key_template, pol.dedupe_key_template, pol.flush_threshold,
         pol.escalate_when ? JSON.stringify(pol.escalate_when) : null,
         pol.escalated_priority, pol.transport_hint, pol.ttl_seconds, pol.honors_unsubscribe],
      );
    }

    const { rows: existing } = await client.query(
      `SELECT 1 FROM api_keys WHERE project_id=$1 AND revoked_at IS NULL LIMIT 1`, [projectId]);
    if (existing.length === 0) {
      const secret = randomBytes(24).toString('base64url');
      const key = `ek_live_${p.slug}_${secret}`;
      const prefix = key.slice(0, `ek_live_${p.slug}_`.length + 8);
      await client.query(
        `INSERT INTO api_keys (project_id, key_prefix, key_hash, label) VALUES ($1,$2,$3,'seed')`,
        [projectId, prefix, createHash('sha256').update(key).digest('hex')],
      );
      issued.push({ slug: p.slug, key });
    }
  }

  const { rows: counts } = await client.query(
    `SELECT p.slug, COUNT(n.id)::int AS events,
            COUNT(n.id) FILTER (WHERE n.audience='owner')::int AS owner_events,
            COUNT(n.id) FILTER (WHERE n.delivery_mode LIKE 'digest:%')::int AS digested
       FROM projects p LEFT JOIN notification_policies n ON n.project_id=p.id
      GROUP BY p.slug ORDER BY p.slug`);

  console.log('\n  Registered projects and events:\n');
  console.log('    project      events   owner   digested');
  for (const c of counts) {
    console.log(`    ${c.slug.padEnd(12)} ${String(c.events).padStart(5)}   ${String(c.owner_events).padStart(5)}   ${String(c.digested).padStart(6)}`);
  }
  const total = counts.reduce((n, c) => n + c.events, 0);
  const owner = counts.reduce((n, c) => n + c.owner_events, 0);
  console.log(`\n    ${total} event types total; ${owner} route to Gmail and cost ZERO Resend quota.`);

  if (issued.length) {
    console.log('\n  API keys (shown ONCE — store them in each project\'s env now):\n');
    for (const i of issued) console.log(`    ${i.slug.padEnd(12)} ${i.key}`);
  } else {
    console.log('\n  All projects already have keys. Use the admin API to rotate.');
  }
  console.log('');
} finally {
  await client.end();
}
