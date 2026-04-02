-- 020_snapshot_safety.sql
-- Snapshot safety improvements: stable device fingerprint per IG account,
-- per-job device snapshot, warmup deduplication, first-snapshot detection.
--
-- These changes make every API request within a snapshot job use a single
-- stable device identity, eliminating the per-request User-Agent rotation
-- that was a major "unusual activity" flag trigger.

-- ═══════════════════════════════════════════════════════════════
-- ig_accounts: persistent device fingerprint
-- ═══════════════════════════════════════════════════════════════
-- Assigned once on connect-instagram (or backfilled on first snapshot).
-- Reused for every future snapshot so Instagram sees a single device.

ALTER TABLE public.ig_accounts
  ADD COLUMN IF NOT EXISTS device_ua    TEXT,
  ADD COLUMN IF NOT EXISTS device_id    TEXT,
  ADD COLUMN IF NOT EXISTS android_id   TEXT;

COMMENT ON COLUMN public.ig_accounts.device_ua  IS 'Stable User-Agent string assigned on connect. Reused across all snapshot jobs for this account.';
COMMENT ON COLUMN public.ig_accounts.device_id  IS 'Stable device UUID for X-IG-Device-ID header. Assigned once on connect.';
COMMENT ON COLUMN public.ig_accounts.android_id IS 'Stable Android device ID for X-IG-Android-ID header (android-<16 hex>). Assigned once on connect.';

-- ═══════════════════════════════════════════════════════════════
-- snapshot_jobs: per-job device snapshot + safety flags
-- ═══════════════════════════════════════════════════════════════
-- Copied from ig_accounts at job creation so the entire job is internally
-- consistent even if the account's device profile is later regenerated.

ALTER TABLE public.snapshot_jobs
  ADD COLUMN IF NOT EXISTS device_ua         TEXT,
  ADD COLUMN IF NOT EXISTS device_id         TEXT,
  ADD COLUMN IF NOT EXISTS android_id        TEXT,
  ADD COLUMN IF NOT EXISTS warmup_done       BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_first_snapshot BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.snapshot_jobs.device_ua         IS 'User-Agent used for every request in this job. Copied from ig_accounts at creation.';
COMMENT ON COLUMN public.snapshot_jobs.device_id         IS 'Device UUID (X-IG-Device-ID) used for this job.';
COMMENT ON COLUMN public.snapshot_jobs.android_id        IS 'Android device ID (X-IG-Android-ID) used for this job.';
COMMENT ON COLUMN public.snapshot_jobs.warmup_done       IS 'True once the /current_user/ warmup call has fired for this job. Prevents redundant warmups on resume.';
COMMENT ON COLUMN public.snapshot_jobs.is_first_snapshot IS 'True when this is the account''s first-ever snapshot. Triggers ultra-safe pacing.';
