/**
 * Register the projects and their email types.
 *
 *   npm run db:seed
 *
 * This file IS the inventory — every row came from reading the projects'
 * source. In v3 a policy is small, because the gateway no longer schedules
 * anything: it records identity (audience, from-name), an optional transport
 * override, whether an unsubscribe applies, and a flood cooldown.
 *
 * COOLDOWN is the one that earns its keep. Error alerts share a dedupe key, so
 * a broken endpoint firing 47 identical errors produces one email instead of
 * forty-seven. Both projects already did this before the gateway existed.
 *
 * Re-running is safe: projects and policies upsert, and keys are only minted
 * for projects that do not have one.
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

// One verified domain (Resend free = 1), so identity is the local part.
const PROJECTS = [
  { slug: 'medqize',   display_name: 'SQB',       from_local_part: 'noreply', default_from_name: 'SQB',       locale: 'ar', dir: 'rtl', daily_max: 60,
    origins: ['medquiz.vercel.app', 'medquiz-web.vercel.app', 'smle-question-bank.com', 'www.smle-question-bank.com'] },
  { slug: 'hr',        display_name: 'HR system', from_local_part: 'hr',      default_from_name: 'HR system', locale: 'ar', dir: 'rtl', daily_max: 50,
    origins: ['hr-react-theta.vercel.app'] },
  { slug: 'portfolio', display_name: 'Portfolio', from_local_part: 'contact', default_from_name: 'Alshraky',  locale: 'en', dir: 'ltr', daily_max: 20,
    origins: ['alshraky.com', 'www.alshraky.com', 'web-dev-seven-iota.vercel.app', 'portfolio-api-rose.vercel.app'] },
  { slug: 'game',      display_name: 'Te3rafni',  from_local_part: 'play',    default_from_name: 'تعرفني',    locale: 'ar', dir: 'rtl', daily_max: 20,
    origins: ['te3rafni.vercel.app', 'tarboosh.vercel.app'] },
];

/** 15 minutes of silence per identical error key. */
const ERROR_COOLDOWN = 900;

// event, audience, { noUnsub, cooldown, transport }
const P = (event_type, audience, opts = {}) => ({
  event_type,
  audience,
  // Kept only so suppressions can grade: 0-1 are things a user is waiting for
  // and must survive an unsubscribe; 3+ is marketing.
  priority: opts.priority ?? (audience === 'owner' ? 2 : 1),
  honors_unsubscribe: opts.noUnsub ? false : true,
  cooldown_seconds: opts.cooldown ?? 0,
  transport_hint: opts.transport ?? null,
});

const POLICIES = {
  // ── MEDQIZE / SQB ─────────────────────────────────────────────────────────
  medqize: [
    // A human is blocked on these; an unsubscribe must never withhold them.
    P('medqize.otp.signup', 'user', { priority: 0, noUnsub: true }),
    P('medqize.otp.reset',  'user', { priority: 0, noUnsub: true }),
    P('medqize.invoice',    'user', { priority: 1, noUnsub: true }),

    P('medqize.question_report.corrected', 'user', { priority: 1 }),
    P('medqize.question_report.confirmed', 'user', { priority: 1 }),

    // Owner-facing. Errors share a dedupe key, so repeats are swallowed.
    P('medqize.owner.backend_error',         'owner', { cooldown: ERROR_COOLDOWN }),
    P('medqize.owner.contact_form',          'owner'),
    P('medqize.owner.suggestion',            'owner'),
    P('medqize.owner.question_report_filed', 'owner'),
    P('medqize.owner.payment_received',      'owner'),
    P('medqize.owner.subscriptions_report',  'owner'),
    P('medqize.owner.admin_account_created', 'owner'),
    P('medqize.owner.temp_link_account',     'owner'),
    P('medqize.owner.test_email',            'owner'),

    // Lifecycle and bulk: marketing, so an unsubscribe applies.
    P('medqize.lifecycle.welcome',    'user', { priority: 3 }),
    P('medqize.lifecycle.inactivity', 'user', { priority: 3 }),
    P('medqize.lifecycle.streak',     'user', { priority: 3 }),
    P('medqize.lifecycle.feedback',   'user', { priority: 3 }),
    P('medqize.broadcast.campaign',   'user', { priority: 4 }),
    P('medqize.broadcast.test',       'owner'),
    P('medqize.campaign.free_era',    'user', { priority: 4 }),
    P('medqize.campaign.free_era_preview', 'owner'),
  ],

  // ── HR- ───────────────────────────────────────────────────────────────────
  hr: [
    P('hr.otp.login', 'user', { priority: 0, noUnsub: true }),

    P('hr.request.answered_user',   'user', { priority: 1 }),
    P('hr.request.answered_branch', 'user', { priority: 1 }),
    P('hr.suggestion.updated',      'user', { priority: 1 }),

    P('hr.owner.system_error',         'owner', { cooldown: ERROR_COOLDOWN }),
    P('hr.owner.daily_critical_stats', 'owner'),
    P('hr.owner.expiry_summary',       'owner'),
    P('hr.owner.notification_created', 'owner'),
    P('hr.owner.branch_replied',       'owner'),
    P('hr.owner.new_request',          'owner'),
    P('hr.owner.new_suggestion',       'owner'),
    P('hr.owner.email_update_request', 'owner'),
    P('hr.owner.test_email',           'owner'),

    // The six fan-out loops — these are what /send/bulk exists for.
    P('hr.branch.daily_expiry',      'user', { priority: 2 }),
    P('hr.branch.manual_expiry',     'user', { priority: 2 }),
    P('hr.branch.notify_all',        'user', { priority: 2 }),
    P('hr.branch.payroll_reopened',  'user', { priority: 2 }),
    P('hr.branch.new_academic_year', 'user', { priority: 2 }),
    P('hr.branch.new_term',          'user', { priority: 2 }),
  ],

  // ── portfolio — every one of these goes to the owner ───────────────────────
  portfolio: [
    P('portfolio.owner.contact_form',    'owner'),
    // One key for all resume pings, so a crawler cannot flood the inbox.
    P('portfolio.owner.resume_download', 'owner', { cooldown: 3600 }),
    P('portfolio.owner.job_digest',      'owner'),
    P('portfolio.owner.evening_checkin', 'owner'),
    P('portfolio.owner.email_jobs',      'owner'),
  ],

  // ── game — greenfield, central templates only ─────────────────────────────
  game: [
    P('game.owner.feedback', 'owner'),
  ],
};

await client.connect();
try {
  const issued = [];

  for (const p of PROJECTS) {
    const { rows } = await client.query(
      `INSERT INTO projects (slug, display_name, from_local_part, default_from_name,
                             default_locale, default_dir, daily_max, production_origins)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (slug) DO UPDATE SET
         display_name=EXCLUDED.display_name,
         from_local_part=EXCLUDED.from_local_part,
         default_from_name=EXCLUDED.default_from_name,
         default_locale=EXCLUDED.default_locale,
         default_dir=EXCLUDED.default_dir,
         daily_max=EXCLUDED.daily_max,
         production_origins=EXCLUDED.production_origins
       RETURNING id`,
      [p.slug, p.display_name, p.from_local_part, p.default_from_name, p.locale, p.dir, p.daily_max, p.origins],
    );
    const projectId = rows[0].id;

    for (const pol of POLICIES[p.slug] ?? []) {
      await client.query(
        `INSERT INTO notification_policies
           (project_id, event_type, priority, audience, transport_hint,
            honors_unsubscribe, cooldown_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, event_type) DO UPDATE SET
           priority=EXCLUDED.priority, audience=EXCLUDED.audience,
           transport_hint=EXCLUDED.transport_hint,
           honors_unsubscribe=EXCLUDED.honors_unsubscribe,
           cooldown_seconds=EXCLUDED.cooldown_seconds`,
        [projectId, pol.event_type, pol.priority, pol.audience,
         pol.transport_hint, pol.honors_unsubscribe, pol.cooldown_seconds],
      );
    }

    const { rows: existing } = await client.query(
      `SELECT 1 FROM api_keys WHERE project_id=$1 AND revoked_at IS NULL LIMIT 1`, [projectId]);
    if (existing.length === 0) {
      const secret = randomBytes(24).toString('base64url');
      const key = `ek_live_${p.slug}_${secret}`;
      await client.query(
        `INSERT INTO api_keys (project_id, key_prefix, key_hash, label) VALUES ($1,$2,$3,'seed')`,
        [projectId, key.slice(0, `ek_live_${p.slug}_`.length + 8), createHash('sha256').update(key).digest('hex')],
      );
      issued.push({ slug: p.slug, key });
    }
  }

  const { rows: counts } = await client.query(
    `SELECT p.slug, COUNT(n.id)::int AS events,
            COUNT(n.id) FILTER (WHERE n.audience='owner')::int AS owner_events,
            COUNT(n.id) FILTER (WHERE n.cooldown_seconds > 0)::int AS throttled,
            array_length(p.production_origins, 1) AS origins
       FROM projects p LEFT JOIN notification_policies n ON n.project_id=p.id
      GROUP BY p.id, p.slug ORDER BY p.slug`);

  console.log('\n  Registered projects and events:\n');
  console.log('    project      events   owner   throttled   origins');
  for (const c of counts) {
    console.log(`    ${c.slug.padEnd(12)} ${String(c.events).padStart(5)}   ${String(c.owner_events).padStart(5)}   ${String(c.throttled).padStart(9)}   ${c.origins ?? 0}`);
  }
  const total = counts.reduce((n, c) => n + c.events, 0);
  console.log(`\n    ${total} event types. Every one sends immediately on arrival.`);
  console.log('    Resend carries them; Gmail takes over only if the daily budget runs out.');

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
