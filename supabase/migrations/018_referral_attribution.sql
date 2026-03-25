-- ============================================================
-- Migration 018 — Ambassador referral attribution
-- Adds first-touch referral tracking to profiles.
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS referred_by  TEXT,
  ADD COLUMN IF NOT EXISTS referred_at  TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.referred_by
  IS 'Ambassador / referral code (lowercase, alphanumeric). Set once — immutable after first write.';
COMMENT ON COLUMN public.profiles.referred_at
  IS 'Timestamp when referred_by was first set. Non-null = locked.';

-- Index for per-ambassador analytics queries
CREATE INDEX IF NOT EXISTS idx_profiles_referred_by
  ON public.profiles (referred_by) WHERE referred_by IS NOT NULL;
