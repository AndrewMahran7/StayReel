-- ============================================================
-- Migration 015 — Subscription tracking fields
-- Adds:
--   profiles.rc_customer_id         — RevenueCat customer ID
--   profiles.subscription_status    — current subscription state
--   profiles.subscription_expires_at — when the current period ends
--   profiles.free_snapshots_used    — count of free snapshots consumed
--   profiles.free_snapshot_limit    — max free snapshots allowed (default 1)
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS rc_customer_id          TEXT,
  ADD COLUMN IF NOT EXISTS subscription_status     TEXT NOT NULL DEFAULT 'free'
    CHECK (subscription_status IN ('free', 'trial', 'active', 'expired', 'cancelled')),
  ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS free_snapshots_used     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS free_snapshot_limit     INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN public.profiles.rc_customer_id
  IS 'RevenueCat customer ID ($app_user_id). Set on first SDK init.';
COMMENT ON COLUMN public.profiles.subscription_status
  IS 'Current subscription state synced from RevenueCat webhook.';
COMMENT ON COLUMN public.profiles.subscription_expires_at
  IS 'Current subscription period end date. NULL for free users.';
COMMENT ON COLUMN public.profiles.free_snapshots_used
  IS 'Number of free snapshots consumed. Incremented by snapshot-start.';
COMMENT ON COLUMN public.profiles.free_snapshot_limit
  IS 'Maximum free snapshots a user gets before paywall. Default 1.';

-- Index for webhook lookups by RevenueCat customer ID
CREATE INDEX IF NOT EXISTS idx_profiles_rc_customer_id
  ON public.profiles (rc_customer_id) WHERE rc_customer_id IS NOT NULL;
