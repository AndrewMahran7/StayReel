-- ============================================================
-- Migration 016 — School attribution for ambassador tracking
-- Depends on: 001_profiles.sql
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS school              TEXT,
  ADD COLUMN IF NOT EXISTS school_selected_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS school_do_not_ask   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS referral_source     TEXT;

COMMENT ON COLUMN public.profiles.school
  IS 'Self-reported school / university. NULL until the user picks one.';
COMMENT ON COLUMN public.profiles.school_selected_at
  IS 'Timestamp when the user chose their school (or dismissed the prompt).';
COMMENT ON COLUMN public.profiles.school_do_not_ask
  IS 'TRUE after user taps "Don''t ask again" — suppresses the school picker modal.';
COMMENT ON COLUMN public.profiles.referral_source
  IS 'Free-text referral / ambassador code for future commission tracking.';

-- Index for analytics grouping
CREATE INDEX IF NOT EXISTS idx_profiles_school ON public.profiles (school)
  WHERE school IS NOT NULL;
