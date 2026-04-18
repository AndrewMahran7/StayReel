-- 028_timezone_and_notification_cooldown.sql
--
-- Adds per-user timezone for local-time scheduling
-- and notification cooldown tracking for dedup.

-- ── 1. Timezone on profiles ─────────────────────────────────────────────
-- IANA timezone string (e.g. "America/Los_Angeles").
-- NULL = not yet reported by client → scheduler falls back to UTC.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN profiles.timezone IS
  'IANA timezone string reported by the client (e.g. America/Los_Angeles). NULL = unknown, scheduler uses UTC.';

-- ── 2. Notification cooldown on profiles ────────────────────────────────
-- Tracks when the last auto-snapshot notification was sent so we can
-- enforce a minimum gap (e.g. 12 hours) between notifications.
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS last_notification_sent_at timestamptz;

COMMENT ON COLUMN profiles.last_notification_sent_at IS
  'UTC timestamp of the last auto-snapshot push notification sent to this user. Used for cooldown enforcement.';

-- ── 3. Backoff timestamp on ig_accounts ─────────────────────────────────
-- Stores the timestamp of the last auto-snapshot failure so we can
-- implement exponential backoff (not just a counter).
ALTER TABLE ig_accounts
  ADD COLUMN IF NOT EXISTS last_auto_snapshot_fail_at timestamptz;

COMMENT ON COLUMN ig_accounts.last_auto_snapshot_fail_at IS
  'UTC timestamp of the last auto-snapshot failure. Used with auto_snapshot_fail_count for exponential backoff.';
