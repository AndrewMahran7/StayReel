-- ============================================================
-- Migration 029 — Auto snapshot opt-in (default OFF)
-- Depends on: 028_timezone_and_notification_cooldown.sql
-- ============================================================
--
-- Changes auto_snapshot_enabled from default TRUE → FALSE.
-- Existing users are reset to FALSE — they must explicitly opt in.
-- This protects user trust and reduces unwanted Instagram activity.

-- 1. Change column default for new rows
ALTER TABLE public.ig_accounts
  ALTER COLUMN auto_snapshot_enabled SET DEFAULT FALSE;

-- 2. Reset all existing accounts to opted-out
UPDATE public.ig_accounts
  SET auto_snapshot_enabled = FALSE,
      updated_at = NOW()
  WHERE auto_snapshot_enabled = TRUE;

COMMENT ON COLUMN public.ig_accounts.auto_snapshot_enabled IS
  'User must explicitly opt in. FALSE by default — scheduler skips accounts where this is false.';
