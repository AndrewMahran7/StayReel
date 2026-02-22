-- ============================================================
-- Migration 009 — Add following-change columns to diffs
-- Depends on: 004_diffs.sql
--
-- Adds:
--   you_unfollowed      — accounts you unfollowed between snapshots
--   you_newly_followed  — accounts you started following between snapshots
--   following_json      — current following list blob on follower_snapshots
--                         (mirrors followers_json; same 30-day TTL)
-- ============================================================

-- ── diffs table: new following-action columns ─────────────────

ALTER TABLE public.diffs
  ADD COLUMN IF NOT EXISTS you_unfollowed     JSONB NOT NULL DEFAULT '[]'::JSONB,
  ADD COLUMN IF NOT EXISTS you_newly_followed JSONB NOT NULL DEFAULT '[]'::JSONB;

COMMENT ON COLUMN public.diffs.you_unfollowed IS
  'JSONB [{ig_id, username}]. Accounts the user unfollowed between from→to snapshot.';

COMMENT ON COLUMN public.diffs.you_newly_followed IS
  'JSONB [{ig_id, username}]. Accounts the user started following between from→to snapshot.';

-- ── follower_snapshots: add following_json blob ───────────────
-- Stores the following list alongside followers_json.
-- Same TTL: NULLed by cron after list_expires_at.

ALTER TABLE public.follower_snapshots
  ADD COLUMN IF NOT EXISTS following_count INTEGER NOT NULL DEFAULT 0
    CHECK (following_count >= 0),
  ADD COLUMN IF NOT EXISTS following_json  JSONB;

COMMENT ON COLUMN public.follower_snapshots.following_json IS
  'Denormalised following list [{ig_id, username}]. Nulled after list_expires_at by cron.';

-- ── Remove the old following_count column clash ────────────────
-- (The original schema already has following_count; the ALTER above
--  uses IF NOT EXISTS so it is a no-op if the column already exists.)

-- ── Index: speed up following_json expiry scan ───────────────
CREATE INDEX IF NOT EXISTS idx_snapshots_following_expiry
  ON public.follower_snapshots (list_expires_at)
  WHERE following_json IS NOT NULL;

-- ── Update cron job comment to prune following_json too ──────
-- (The actual cron is in 007_indexes_functions.sql.
--  Update the prune block to also null following_json.)

-- Reminder: update the pg_cron prune job to include:
--   UPDATE public.follower_snapshots
--   SET followers_json = NULL, following_json = NULL
--   WHERE list_expires_at < NOW()
--     AND (followers_json IS NOT NULL OR following_json IS NOT NULL);
