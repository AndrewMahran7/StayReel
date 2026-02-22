-- ============================================================
-- Migration 012 — Snapshot enhancements
-- Adds:
--   ig_accounts.last_snapshot_at      — timestamp of most-recent successful snapshot
--   ig_accounts.current_streak_days   — current growth streak (net >= 0)
--   ig_accounts.longest_streak_days   — all-time best streak
--   follower_snapshots.mutual_count   — cached intersection of followers ∩ following
-- ============================================================

-- ── ig_accounts enhancements ──────────────────────────────────

ALTER TABLE public.ig_accounts
  ADD COLUMN IF NOT EXISTS last_snapshot_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_streak_days INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS longest_streak_days INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ig_accounts.last_snapshot_at    IS 'Timestamp of most-recent successful snapshot. Used to enforce 24-hour limit.';
COMMENT ON COLUMN public.ig_accounts.current_streak_days IS 'Consecutive days where net follower change >= 0.';
COMMENT ON COLUMN public.ig_accounts.longest_streak_days IS 'All-time max streak.';

-- Backfill last_snapshot_at from existing snapshot data
UPDATE public.ig_accounts ia
SET    last_snapshot_at = sub.most_recent
FROM (
  SELECT ig_account_id, MAX(captured_at) AS most_recent
  FROM   public.follower_snapshots
  GROUP  BY ig_account_id
) sub
WHERE ia.id = sub.ig_account_id
  AND ia.last_snapshot_at IS NULL;

-- ── follower_snapshots enhancements ──────────────────────────

ALTER TABLE public.follower_snapshots
  ADD COLUMN IF NOT EXISTS mutual_count INTEGER;

COMMENT ON COLUMN public.follower_snapshots.mutual_count IS 'Count of users in both followers and following lists (mutual follows).';
