-- ═══════════════════════════════════════════════════════════════════════════
--  CENTRAL EMAIL GATEWAY — SCHEMA (v3)
--  Idempotent: safe to run on every boot, and safe to run over a v2 database.
--
--  v3 removed the queue. Mail is sent synchronously when the request arrives;
--  if the Resend budget is spent it goes over Gmail instead. Nothing is
--  deferred, so the scheduling machinery — priorities, reserves, ceilings,
--  digest buffers, drain leases — is gone.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────── registry ─────────────────────────────────

CREATE TABLE IF NOT EXISTS projects (
  id                 SERIAL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  from_local_part    TEXT NOT NULL,            -- 'noreply' -> noreply@<MAIL_DOMAIN>
  default_from_name  TEXT NOT NULL,
  reply_to           TEXT,
  default_locale     TEXT NOT NULL DEFAULT 'ar',
  default_dir        TEXT NOT NULL DEFAULT 'rtl' CHECK (default_dir IN ('rtl','ltr')),
  best_priority      SMALLINT NOT NULL DEFAULT 1,   -- retained for compatibility; unused in v3
  daily_max          INT NOT NULL DEFAULT 60,       -- bug containment, not rationing
  monthly_max        INT NOT NULL DEFAULT 1500,
  allowed_transports TEXT[] NOT NULL DEFAULT '{resend,gmail}',
  dry_run            BOOLEAN NOT NULL DEFAULT TRUE,
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Production hostnames for THIS project, merged with the global
-- PRODUCTION_ORIGINS. Per-project so onboarding a new app never needs a
-- gateway redeploy — without it, a new app's mail is silently dropped.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_origins TEXT[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  project_id   INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_prefix   TEXT NOT NULL,          -- safe to log
  key_hash     TEXT NOT NULL,          -- sha256 of the full key
  label        TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys(key_hash);
CREATE INDEX        IF NOT EXISTS idx_api_keys_active ON api_keys(project_id) WHERE revoked_at IS NULL;

-- ───────────────────────── per-event policy ───────────────────────────────
-- Much smaller in v3: identity, transport override, and flood control.

CREATE TABLE IF NOT EXISTS notification_policies (
  id                 SERIAL PRIMARY KEY,
  project_id         INT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type         TEXT NOT NULL,
  priority           SMALLINT NOT NULL DEFAULT 2,   -- retained for the log; no longer schedules
  audience           TEXT NOT NULL DEFAULT 'user' CHECK (audience IN ('owner','internal','user')),
  transport_hint     TEXT CHECK (transport_hint IN ('resend','gmail','noop')),
  honors_unsubscribe BOOLEAN NOT NULL DEFAULT TRUE, -- FALSE for OTP and invoices
  active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, event_type)
);

-- Seconds to swallow identical dedupe_key repeats. Inbox sanity, not quota:
-- one broken endpoint firing 47 identical alerts should send one email.
ALTER TABLE notification_policies ADD COLUMN IF NOT EXISTS cooldown_seconds INT NOT NULL DEFAULT 0;

-- v2 columns that no longer drive anything. Left in place rather than dropped
-- so a rollback to v2 is possible; nothing reads them.
ALTER TABLE notification_policies ALTER COLUMN delivery_mode DROP NOT NULL;

-- ───────────────────────────── settings ───────────────────────────────────

CREATE TABLE IF NOT EXISTS quota_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- The ONLY tunable that matters now: how many Resend emails per rolling 24h
-- before overflowing to Gmail. Under the real 100 so a burst never earns a
-- hard 429 from the provider.
INSERT INTO quota_settings (k, v) VALUES ('daily_budget', '95')
  ON CONFLICT (k) DO NOTHING;

-- ──────────────────────── messages: the delivery log ──────────────────────

CREATE TABLE IF NOT EXISTS messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      INT NOT NULL REFERENCES projects(id),
  event_type      TEXT NOT NULL,
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

  status          TEXT NOT NULL DEFAULT 'sending',
  status_reason   TEXT,
  transport       TEXT NOT NULL DEFAULT 'resend',
  provider_id     TEXT,
  attempts        SMALLINT NOT NULL DEFAULT 0,
  last_error      TEXT,

  idempotency_key TEXT,
  dedupe_key      TEXT,
  source_origin   TEXT,

  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- New in v3.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS severity    TEXT NOT NULL DEFAULT 'info';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;

-- v2 columns the new send path does not populate. They were NOT NULL, which
-- would reject every v3 insert, so relax them rather than dropping (a drop
-- would make rolling back to v2 lossy).
ALTER TABLE messages ALTER COLUMN priority     DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN scheduled_at DROP NOT NULL;
ALTER TABLE messages ALTER COLUMN expires_at   DROP NOT NULL;

-- `sending` and `throttled` are v3 states; the old queue states stay valid so
-- historical rows keep their meaning.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN (
  'sending','sent','failed','dropped','suppressed','throttled','cancelled',
  'queued','claimed','attempting','dead','expired'   -- legacy, v2 rows only
));

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idem
  ON messages(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- The hot read: how many Resend sends in the rolling window. `sending` counts
-- alongside `sent` because a request that timed out after the provider
-- accepted it consumed quota we will never see acknowledged.
CREATE INDEX IF NOT EXISTS idx_messages_window
  ON messages(sent_at, created_at)
  WHERE status IN ('sent','sending') AND transport = 'resend';

CREATE INDEX IF NOT EXISTS idx_messages_retry
  ON messages(retry_after) WHERE status = 'failed' AND retry_after IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_dedupe   ON messages(project_id, dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_to       ON messages(lower(to_address), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_created  ON messages(created_at DESC);

-- ──────────────────────────────── attachments ─────────────────────────────

CREATE TABLE IF NOT EXISTS message_attachments (
  id           SERIAL PRIMARY KEY,
  message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  content_b64  TEXT,
  remote_url   TEXT,
  byte_size    INT NOT NULL DEFAULT 0,
  purged_at    TIMESTAMPTZ,        -- content dropped 24h after send (PII)
  CHECK (content_b64 IS NOT NULL OR remote_url IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_attach_msg   ON message_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_attach_purge ON message_attachments(purged_at) WHERE purged_at IS NULL;

-- ─────────────────────── provider events (webhooks) ───────────────────────

CREATE TABLE IF NOT EXISTS message_events (
  id          BIGSERIAL PRIMARY KEY,
  message_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
  provider_id TEXT,
  event_type  TEXT NOT NULL,
  bounce_type TEXT,
  raw         JSONB NOT NULL,
  svix_id     TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_svix ON message_events(svix_id) WHERE svix_id IS NOT NULL;
CREATE INDEX        IF NOT EXISTS idx_events_msg  ON message_events(message_id, occurred_at DESC);

-- ──────────────────────────────── suppression ─────────────────────────────
-- Every project sends from ONE domain and shares ONE reputation, so a bounce
-- generated by any of them degrades delivery for all. Not optional.

CREATE TABLE IF NOT EXISTS suppressions (
  id                   SERIAL PRIMARY KEY,
  email                TEXT NOT NULL,
  scope                TEXT NOT NULL DEFAULT 'global',
  reason               TEXT NOT NULL
                         CHECK (reason IN ('hard_bounce','complaint','unsubscribe','manual','soft_bounce_3x')),
  -- 0 blocks everything including OTP (complaint / hard bounce).
  -- 2 blocks marketing only — nobody can opt out of their own password reset.
  blocks_from_priority SMALLINT NOT NULL DEFAULT 2,
  source_message_id    UUID,
  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at           TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_supp_active
  ON suppressions(lower(email), scope) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS soft_bounces (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_soft_bounce ON soft_bounces(lower(email), occurred_at DESC);

-- ───────────────── v2 machinery, no longer used ───────────────────────────
-- The queue is gone: no scheduled flush, no drain lease, no priority classes.
DROP TABLE IF EXISTS digest_buffer;
DROP TABLE IF EXISTS gateway_locks;
DROP TABLE IF EXISTS drain_runs;
DROP TABLE IF EXISTS quota_policy;

CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO schema_meta (k, v) VALUES ('version', '3')
  ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
