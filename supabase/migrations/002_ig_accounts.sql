-- ============================================================
-- Migration 002 — ig_accounts
-- Depends on: 001_profiles.sql
-- ============================================================

CREATE TABLE public.ig_accounts (
  id                  UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID                     NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

  -- Instagram identifiers
  ig_user_id          TEXT                     NOT NULL,   -- Instagram numeric user ID (stable)
  username            TEXT                     NOT NULL,   -- @handle (may change, re-synced on each snapshot)
  full_name           TEXT,
  profile_pic_url     TEXT,
  is_business         BOOLEAN                  NOT NULL DEFAULT FALSE,

  -- Token management ─────────────────────────────────────────
  -- The raw token is NEVER stored here.
  -- It lives in Supabase Vault; this column holds the Vault secret ID.
  -- Edge Functions retrieve it with vault.decrypted_secrets.
  vault_secret_id     UUID,                               -- references vault.secrets(id)
  token_type          TEXT                     NOT NULL DEFAULT 'basic_display'
                      CHECK (token_type IN ('basic_display', 'graph_api', 'session_cookie')),
  token_expires_at    TIMESTAMPTZ,
  last_token_refresh  TIMESTAMPTZ,

  -- Account lifecycle
  status              public.ig_account_status NOT NULL DEFAULT 'pending',
  last_verified_at    TIMESTAMPTZ,                        -- last time the token was confirmed valid
  connected_at        TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  disconnected_at     TIMESTAMPTZ,

  -- Snapshot cadence (can differ per account on Pro tier)
  snapshot_frequency  TEXT                     NOT NULL DEFAULT 'daily'
                      CHECK (snapshot_frequency IN ('hourly', 'daily')),

  -- Soft-delete
  deleted_at          TIMESTAMPTZ,

  created_at          TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ              NOT NULL DEFAULT NOW(),

  -- One active account per IG user ID per app user
  UNIQUE (user_id, ig_user_id)
);

COMMENT ON TABLE  public.ig_accounts IS 'One row per Instagram account connected to an app user.';
COMMENT ON COLUMN public.ig_accounts.ig_user_id    IS 'Numeric Instagram user ID — stable across username changes.';
COMMENT ON COLUMN public.ig_accounts.vault_secret_id IS 'FK into Supabase Vault. Token never stored in plain text in this table.';
COMMENT ON COLUMN public.ig_accounts.last_verified_at IS 'Timestamp of last successful API call with this token. Used to detect silent expiry.';

-- ── Per-account rate-limit quota ─────────────────────────────

CREATE TABLE public.snapshot_quota (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID    NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  quota_date      DATE    NOT NULL DEFAULT CURRENT_DATE,
  manual_count    INTEGER NOT NULL DEFAULT 0,  -- manual refreshes today
  cron_count      INTEGER NOT NULL DEFAULT 0,  -- scheduled captures today
  UNIQUE (user_id, quota_date)
);

COMMENT ON TABLE  public.snapshot_quota IS 'Daily manual-refresh counter per user. Edge Function enforces max 3/day.';
