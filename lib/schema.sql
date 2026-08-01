-- ═══════════════════════════════════════════════════════════════════════════
--  CENTRAL EMAIL GATEWAY — SCHEMA
--  Idempotent: safe to run on every boot. Pattern lifted from MEDQIZE's
--  admin-broadcast.js ensureBroadcastSchema(), which is the reference
--  implementation for this whole queue.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────── registry ─────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id                 SERIAL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,          -- 'medqize' | 'hr' | 'portfolio' | 'game'
  display_name       TEXT NOT NULL,
  from_local_part    TEXT NOT NULL,                 -- 'noreply' -> noreply@<MAIL_DOMAIN>
  default_from_name  TEXT NOT NULL,                 -- 'SQB' | 'HR system'
  reply_to           TEXT,
  default_locale     TEXT NOT NULL DEFAULT 'ar',
  default_dir        TEXT NOT NULL DEFAULT 'rtl' CHECK (default_dir IN ('rtl','ltr')),

  -- Clamp: the best (numerically lowest) priority this project may request.
  -- Stops a project labelling its own broadcast as P0.
  best_priority      SMALLINT NOT NULL DEFAULT 1 CHECK (best_priority BETWEEN 0 AND 4),

  -- Bug containment. A runaway fan-out loop eats at most this much of the
  -- shared budget, never the whole thing.
  daily_max          INT NOT NULL DEFAULT 60,
  monthly_max        INT NOT NULL DEFAULT 1500,

  allowed_transports TEXT[] NOT NULL DEFAULT '{resend,gmail}',
  dry_run            BOOLEAN NOT NULL DEFAULT TRUE, -- per-project shadow mode
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Production hostnames for THIS project, checked in addition to the global
-- PRODUCTION_ORIGINS env var.
--
-- Origins have to be per-project or the system does not scale: onboarding a new
-- app would mean editing a gateway env var and redeploying the gateway, and
-- until someone did, every email that app sent would be silently dropped as a
-- non-production origin. Registering the project should be enough.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_origins TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix   TEXT NOT NULL,          -- 'ek_live_medqize_a1b2c3d4' — safe to log
  key_hash     TEXT NOT NULL,          -- sha256 hex of the full key
  label        TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);
CREATE INDEX        IF NOT EXISTS idx_api_keys_active ON api_keys(project_id) WHERE revoked_at IS NULL;

-- ───────────────────────── per-event routing policy ───────────────────────
-- The gateway decides priority/transport/digest from THIS table, not from
-- whatever the caller claims.

CREATE TABLE IF NOT EXISTS notification_policies (
  id                  SERIAL PRIMARY KEY,
  project_id          INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,                  -- 'medqize.otp.signup'
  priority            SMALLINT NOT NULL CHECK (priority BETWEEN 0 AND 4),
  audience            TEXT NOT NULL DEFAULT 'user' CHECK (audience IN ('owner','internal','user')),

  delivery_mode       TEXT NOT NULL DEFAULT 'immediate'
                        CHECK (delivery_mode IN ('immediate','digest:hourly','digest:daily','digest:weekly','suppress')),
  digest_key_template TEXT,                           -- 'owner:daily' — shared ACROSS projects
  dedupe_key_template TEXT,                           -- '{{event_type}}:{{data.error_key}}'
  flush_threshold     INT NOT NULL DEFAULT 25,        -- volume trigger; 100 errors in 10min IS the alert

  escalate_when       JSONB,                          -- {"severity":["CRITICAL"]}
  escalated_priority  SMALLINT CHECK (escalated_priority BETWEEN 0 AND 4),

  transport_hint      TEXT CHECK (transport_hint IN ('resend','gmail','noop')),
  ttl_seconds         INT,                            -- NULL -> class default from quota_policy

  -- FALSE for OTP/invoice: nobody unsubscribes from their own password reset.
  honors_unsubscribe  BOOLEAN NOT NULL DEFAULT TRUE,

  active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, event_type)
);

-- ───────────────── tunable quota policy (retune without a deploy) ──────────

CREATE TABLE IF NOT EXISTS quota_policy (
  priority    SMALLINT PRIMARY KEY CHECK (priority BETWEEN 0 AND 4),
  name        TEXT NOT NULL,
  reserve     INT NOT NULL,   -- capacity only classes <= this may touch
  ceiling     INT NOT NULL,   -- max this class may consume in the window
  ttl_seconds INT NOT NULL,
  on_expiry   TEXT NOT NULL CHECK (on_expiry IN ('dead','drop','fold'))
);

INSERT INTO quota_policy (priority, name, reserve, ceiling, ttl_seconds, on_expiry) VALUES
  (0, 'urgent',        25, 95,     0, 'dead'),
  (1, 'transactional', 20, 60, 86400, 'dead'),
  (2, 'operational',   10, 25, 43200, 'fold'),
  (3, 'lifecycle',      0, 30, 172800, 'drop'),
  (4, 'bulk',           0, 40, 2592000, 'drop')
ON CONFLICT (priority) DO NOTHING;

CREATE TABLE IF NOT EXISTS quota_settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- daily_ceiling is deliberately LOW while legacy senders are still live:
-- during migration both the projects and the gateway send, but the gateway
-- only sees its own traffic. Raise it as each project cuts over.
INSERT INTO quota_settings (k, v) VALUES
  ('daily_ceiling',     '40'),
  ('monthly_ceiling', '2900'),
  ('burst_multiplier','1.25'),
  ('per_send_delay_ms', '600'),
  ('drain_batch_size',    '5'),
  ('stuck_reclaim_min',   '5')
ON CONFLICT (k) DO NOTHING;

-- ─────────────────────── the queue AND the log, one table ─────────────────

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      INT NOT NULL REFERENCES projects(id),
  event_type      TEXT NOT NULL,
  priority        SMALLINT NOT NULL CHECK (priority BETWEEN 0 AND 4),
  audience        TEXT NOT NULL DEFAULT 'user',

  to_address      TEXT NOT NULL,
  to_name         TEXT,
  from_name       TEXT NOT NULL,
  from_address    TEXT NOT NULL,
  reply_to        TEXT,
  subject         TEXT NOT NULL,
  html            TEXT,
  text            TEXT,
  headers         JSONB NOT NULL DEFAULT '{}'::jsonb,
  locale          TEXT NOT NULL DEFAULT 'ar',
  dir             TEXT NOT NULL DEFAULT 'rtl',

  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','claimed','attempting','sent','failed',
                                      'dead','expired','suppressed','dropped','cancelled')),
  status_reason   TEXT,
  transport       TEXT NOT NULL DEFAULT 'resend',
  provider_id     TEXT,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  last_error      TEXT,

  idempotency_key TEXT,
  dedupe_key      TEXT,
  batch_id        UUID,          -- /send/bulk grouping
  digest_of       UUID,          -- set when THIS message is a rendered digest
  source_origin   TEXT,          -- what the origin gate judged

  scheduled_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- earliest eligible (backoff/pacing)
  expires_at      TIMESTAMPTZ NOT NULL,
  claimed_at      TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One message per (project, idempotency key). A replayed POST returns the
-- original row instead of sending twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
  ON messages(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The drain claim path.
CREATE INDEX IF NOT EXISTS idx_messages_ready
  ON messages(priority, scheduled_at, created_at)
  WHERE status IN ('queued','claimed');

-- The hot quota read. Note 'attempting' is included: a request that timed out
-- after Resend accepted it consumed quota we will never see acknowledged.
-- Counting optimistically is how you silently exceed 100.
CREATE INDEX IF NOT EXISTS idx_messages_window
  ON messages(sent_at, priority)
  WHERE status IN ('sent','attempting') AND transport = 'resend';

CREATE INDEX IF NOT EXISTS idx_messages_project_window
  ON messages(project_id, sent_at)
  WHERE status IN ('sent','attempting') AND transport = 'resend';

CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_to       ON messages(lower(to_address), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_batch    ON messages(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_stuck    ON messages(claimed_at) WHERE status IN ('claimed','attempting');
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at DESC);

-- ──────────────────────────────── attachments ─────────────────────────────
-- Kept out of `messages` so the queue table stays skinny and the quota index
-- stays small.

CREATE TABLE IF NOT EXISTS message_attachments (
  id           SERIAL PRIMARY KEY,
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_b64  TEXT,          -- inline, <= 2 MB base64
  remote_url   TEXT,          -- preferred above ~1 MB
  byte_size    INT NOT NULL DEFAULT 0,
  purged_at    TIMESTAMPTZ,   -- content_b64 NULLed 24h after terminal status (PII)
  CHECK (content_b64 IS NOT NULL OR remote_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_attach_msg   ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attach_purge ON message_attachments(purged_at) WHERE purged_at IS NULL;

-- ─────────────────────── provider events (webhooks) ───────────────────────

CREATE TABLE IF NOT EXISTS message_events (
  id          BIGSERIAL PRIMARY KEY,
  message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT,
  event_type  TEXT NOT NULL,   -- email.sent|delivered|bounced|complained|delivery_delayed
  bounce_type TEXT,            -- Permanent | Transient
  raw         JSONB NOT NULL,
  svix_id     TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_svix ON message_events(svix_id) WHERE svix_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_events_msg  ON message_events(message_id, occurred_at DESC);

-- ──────────────────────────────── suppression ─────────────────────────────
-- All four projects share ONE domain and ONE reputation. A bounce in `game`
-- degrades SQB's inbox placement. This table is not optional.

CREATE TABLE IF NOT EXISTS suppressions (
  id                   SERIAL PRIMARY KEY,
  email                TEXT NOT NULL,
  scope                TEXT NOT NULL DEFAULT 'global',  -- 'global' | project slug
  reason               TEXT NOT NULL
                         CHECK (reason IN ('hard_bounce','complaint','unsubscribe','manual','soft_bounce_3x')),

  -- 0 = blocks everything including OTP (complaint / hard bounce)
  -- 2 = blocks P2..P4 only (unsubscribe — you cannot opt out of your own reset)
  blocks_from_priority SMALLINT NOT NULL DEFAULT 2 CHECK (blocks_from_priority BETWEEN 0 AND 4),

  source_message_id    UUID,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at           TIMESTAMPTZ            -- soft delete: un-suppress a typo'd address
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supp_active
  ON suppressions(lower(email), scope) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS soft_bounces (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_soft_bounce ON soft_bounces(lower(email), occurred_at DESC);

-- ────────────────────────────── digest buffer ─────────────────────────────

CREATE TABLE IF NOT EXISTS digest_buffer (
  id           BIGSERIAL PRIMARY KEY,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  digest_key   TEXT NOT NULL,        -- 'owner:daily' — deliberately shared across projects
  to_address   TEXT NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  window_end   TIMESTAMPTZ NOT NULL,
  dedupe_key   TEXT NOT NULL,
  priority     SMALLINT NOT NULL DEFAULT 2,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warn','critical')),
  payload      JSONB NOT NULL,       -- { title, summary, dir, fields[], link }
  occurrences  INT NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'buffered' CHECK (status IN ('buffered','flushing','flushed')),
  flush_batch  UUID,
  message_id   UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repeats INCREMENT rather than insert. This generalizes MEDQIZE's 5-minute
-- per-error-key cooldown and is strictly better: the digest reports
-- "DB connection refused x47" instead of silently discarding 46 of them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_digest_dedupe
  ON digest_buffer(digest_key, lower(to_address), window_start, dedupe_key)
  WHERE status = 'buffered';
CREATE INDEX IF NOT EXISTS idx_digest_due   ON digest_buffer(window_end) WHERE status = 'buffered';
CREATE INDEX IF NOT EXISTS idx_digest_batch ON digest_buffer(flush_batch) WHERE flush_batch IS NOT NULL;

-- ───────────────────────────── observability ──────────────────────────────

CREATE TABLE IF NOT EXISTS drain_runs (
  id             BIGSERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  claimed        INT NOT NULL DEFAULT 0,
  sent           INT NOT NULL DEFAULT 0,
  failed         INT NOT NULL DEFAULT 0,
  deferred       INT NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  source         TEXT          -- 'cron-job.org' | 'opportunistic' | 'gh-actions' | 'vercel'
);
CREATE INDEX IF NOT EXISTS idx_drain_runs ON drain_runs(started_at DESC);

-- ───────────────────────── serverless-safe locking ───────────────────────
-- A Postgres advisory lock is session-scoped, which is wrong for serverless:
-- Vercel FREEZES a lambda the moment it returns a response, so a drain that
-- was interrupted mid-flight keeps holding the lock until its TCP session
-- eventually dies, blocking every other drainer in the meantime.
--
-- An expiring lease has no such failure mode. A dead holder simply stops
-- renewing and the lease times out.
CREATE TABLE IF NOT EXISTS gateway_locks (
  name       TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Loud rather than silent drift. Bump when the DDL above changes shape.
CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO schema_meta (k, v) VALUES ('version', '2')
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
