-- ============================================================
-- Migration 026 — Auto daily snapshot + smart notification support
-- Depends on: 025_snapshot_job_locking.sql
-- ============================================================
--
-- Adds columns to support:
--   1. Automatic daily snapshots for recently active users
--   2. Smart notification decisions based on meaningful changes
--   3. Content-aware notification branching (posted since last snapshot)
--   4. Operational safety (failure backoff, cooldown, audit trail)
--
-- Design: conservative, transparent, opt-out. No evasion behavior.

-- ═══════════════════════════════════════════════════════════════
-- 1. profiles: last app open timestamp
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_app_open_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.last_app_open_at IS
  'Last time the user opened the app. Used for auto-snapshot eligibility (active within 7 days).';

-- ═══════════════════════════════════════════════════════════════
-- 2. ig_accounts: auto snapshot settings + state
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.ig_accounts
  ADD COLUMN IF NOT EXISTS auto_snapshot_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS last_auto_snapshot_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_snapshot_fail_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_auto_snapshot_error TEXT;

COMMENT ON COLUMN public.ig_accounts.auto_snapshot_enabled IS
  'User opt-in for automatic daily snapshots. Default ON for connected accounts.';
COMMENT ON COLUMN public.ig_accounts.last_auto_snapshot_at IS
  'Timestamp of the last automatic snapshot attempt. Used to ensure one auto snapshot per day.';
COMMENT ON COLUMN public.ig_accounts.auto_snapshot_fail_count IS
  'Consecutive auto-snapshot failures. Scheduling stops at 3+ until user reconnects. Reset on success.';
COMMENT ON COLUMN public.ig_accounts.last_auto_snapshot_error IS
  'Error message from the last failed auto snapshot. Cleared on success.';

-- ═══════════════════════════════════════════════════════════════
-- 3. user_settings: smart notification preference
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS notify_on_meaningful_change BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN public.user_settings.notify_on_meaningful_change IS
  'Opt-in for push notifications when a snapshot detects meaningful follower changes.';

-- ═══════════════════════════════════════════════════════════════
-- 4. follower_snapshots: content counts from IG API
-- ═══════════════════════════════════════════════════════════════
-- post_count and story_count are captured at snapshot time from the
-- IG profile API response. Used to detect new content since the
-- previous snapshot for content-aware notification branching.
ALTER TABLE public.follower_snapshots
  ADD COLUMN IF NOT EXISTS post_count  INT,
  ADD COLUMN IF NOT EXISTS story_count INT;

COMMENT ON COLUMN public.follower_snapshots.post_count IS
  'Instagram media_count at capture time. Compared between snapshots to detect new posts.';
COMMENT ON COLUMN public.follower_snapshots.story_count IS
  'Instagram reel_count or story indicator at capture time. Compared between snapshots to detect new stories.';

-- ═══════════════════════════════════════════════════════════════
-- 5. diffs: notification audit trail
-- ═══════════════════════════════════════════════════════════════
ALTER TABLE public.diffs
  ADD COLUMN IF NOT EXISTS notification_sent           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS notification_reason         TEXT,
  ADD COLUMN IF NOT EXISTS notification_skipped_reason TEXT;

COMMENT ON COLUMN public.diffs.notification_sent IS
  'Whether a push notification was sent for this diff.';
COMMENT ON COLUMN public.diffs.notification_reason IS
  'Machine-readable reason the notification was sent (e.g. "net_followers_gte_3", "unfollows_after_post").';
COMMENT ON COLUMN public.diffs.notification_skipped_reason IS
  'If notification was not sent, the reason (e.g. "below_threshold", "user_opted_out", "no_push_token").';

-- ═══════════════════════════════════════════════════════════════
-- 6. Index for auto-snapshot eligibility query
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS ig_accounts_auto_eligible
  ON public.ig_accounts (auto_snapshot_enabled, status, deleted_at, last_auto_snapshot_at)
  WHERE auto_snapshot_enabled = TRUE AND status = 'active' AND deleted_at IS NULL;

COMMENT ON INDEX public.ig_accounts_auto_eligible IS
  'Efficient lookup for auto-snapshot-eligible accounts: enabled, active, not deleted.';

-- ═══════════════════════════════════════════════════════════════
-- 7. Index for recent app opens (eligibility check)
-- ═══════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS profiles_last_app_open
  ON public.profiles (last_app_open_at DESC)
  WHERE last_app_open_at IS NOT NULL;
