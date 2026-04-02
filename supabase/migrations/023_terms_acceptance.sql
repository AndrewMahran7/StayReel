-- 023_terms_acceptance.sql
-- Adds Terms of Service + Privacy Policy acceptance tracking to profiles.
-- Lightweight: two nullable columns + a version string.
-- Existing users have NULL values and will be prompted on next sensitive action.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS terms_accepted_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terms_version      TEXT;

COMMENT ON COLUMN public.profiles.terms_accepted_at IS
  'Timestamp when the user last accepted Terms of Service and Privacy Policy.';
COMMENT ON COLUMN public.profiles.terms_version IS
  'Document version string accepted, e.g. "2026-04-02". Allows re-prompting on major updates.';
