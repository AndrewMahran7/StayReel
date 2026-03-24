-- ============================================================
-- Migration 014 — Add notification columns for weekly summary + refresh complete
-- Depends on: 001_profiles.sql (user_settings table)
-- ============================================================

ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS notify_weekly_summary    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_refresh_complete  BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.user_settings.notify_weekly_summary
  IS 'Opt-in for weekly follower summary push notification.';
COMMENT ON COLUMN public.user_settings.notify_refresh_complete
  IS 'Opt-in for snapshot-complete push notification.';
