-- ============================================================
-- Migration 004 — diffs
-- Depends on: 003_snapshots.sql
-- ============================================================

-- ── diffs ────────────────────────────────────────────────────
-- Pre-computed set difference between two consecutive snapshots.
-- Computed by the take-snapshot Edge Function immediately after
-- each new snapshot is inserted.
-- JSONB arrays contain objects: {"ig_id": "...", "username": "..."}
-- ig_id may be null when data source is username-only.

CREATE TABLE public.diffs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_account_id         UUID        NOT NULL REFERENCES public.ig_accounts(id) ON DELETE CASCADE,

  -- The two snapshots being compared (always chronological)
  from_snapshot_id      UUID        NOT NULL REFERENCES public.follower_snapshots(id) ON DELETE CASCADE,
  to_snapshot_id        UUID        NOT NULL REFERENCES public.follower_snapshots(id) ON DELETE CASCADE,

  from_captured_at      TIMESTAMPTZ NOT NULL,  -- denormalised for fast ORDER BY
  to_captured_at        TIMESTAMPTZ NOT NULL,

  -- Net counts (positive = growth)
  net_follower_change   INTEGER     NOT NULL DEFAULT 0,
  net_following_change  INTEGER     NOT NULL DEFAULT 0,

  -- ── Follower set changes ──────────────────────────────────
  -- People who followed you between the two snapshots
  new_followers         JSONB       NOT NULL DEFAULT '[]'::JSONB,
  -- People who unfollowed you between the two snapshots
  lost_followers        JSONB       NOT NULL DEFAULT '[]'::JSONB,

  -- ── Reciprocity sets ─────────────────────────────────────
  -- People you follow who do NOT follow you back (as of to_snapshot)
  not_following_back    JSONB       NOT NULL DEFAULT '[]'::JSONB,
  -- People who follow you but you do NOT follow them back (as of to_snapshot)
  you_dont_follow_back  JSONB       NOT NULL DEFAULT '[]'::JSONB,

  -- Diff quality flag: FALSE when either snapshot was incomplete
  is_complete           BOOLEAN     NOT NULL DEFAULT TRUE,

  computed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One diff per ordered snapshot pair
  UNIQUE (from_snapshot_id, to_snapshot_id),
  -- Ensure chronological order
  CONSTRAINT chk_snapshot_order CHECK (from_captured_at < to_captured_at)
);

COMMENT ON TABLE  public.diffs IS 'Pre-computed follower set differences between consecutive snapshots.';
COMMENT ON COLUMN public.diffs.new_followers        IS 'JSONB array [{ig_id, username}]. People who followed between from→to.';
COMMENT ON COLUMN public.diffs.lost_followers       IS 'JSONB array [{ig_id, username}]. People who unfollowed between from→to.';
COMMENT ON COLUMN public.diffs.not_following_back   IS 'JSONB array [{ig_id, username}]. Accounts you follow that don''t follow you back, as of to_snapshot.';
COMMENT ON COLUMN public.diffs.you_dont_follow_back IS 'JSONB array [{ig_id, username}]. Accounts that follow you but you don''t follow back, as of to_snapshot.';
COMMENT ON COLUMN public.diffs.is_complete          IS 'FALSE when either snapshot had is_list_complete=FALSE, making the diff unreliable.';
