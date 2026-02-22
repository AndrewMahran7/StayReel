-- ============================================================
-- Migration 003 — follower_snapshots + follower_edges
-- Depends on: 002_ig_accounts.sql
-- ============================================================

-- ── follower_snapshots ───────────────────────────────────────
-- One row per point-in-time capture of an IG account's stats.
-- The full follower list (follower_edges) is stored in a
-- separate normalized table and pruned after 30 days to bound
-- storage. Only aggregate counts are kept indefinitely.

CREATE TABLE public.follower_snapshots (
  id                UUID                   PRIMARY KEY DEFAULT gen_random_uuid(),
  ig_account_id     UUID                   NOT NULL REFERENCES public.ig_accounts(id) ON DELETE CASCADE,

  captured_at       TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  source            public.snapshot_source NOT NULL DEFAULT 'cron',

  -- Aggregate counters (kept forever)
  follower_count    INTEGER                NOT NULL CHECK (follower_count >= 0),
  following_count   INTEGER                NOT NULL CHECK (following_count >= 0),
  post_count        INTEGER                NOT NULL DEFAULT 0 CHECK (post_count >= 0),

  -- Optional denormalised blob — useful for small accounts or
  -- when edge rows have already been pruned.
  -- Stored as JSONB array: [{"id":"12345","username":"alice"}, ...]
  -- Set to NULL after list_expires_at to reclaim space.
  followers_json    JSONB,

  -- TTL: raw list expires 30 days after capture (set by trigger)
  list_expires_at   TIMESTAMPTZ            NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),

  -- Was the raw list fully captured (some large accounts may be truncated)
  is_list_complete  BOOLEAN                NOT NULL DEFAULT TRUE,
  error_message     TEXT,                  -- populated when source failed partially

  created_at        TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.follower_snapshots IS 'Point-in-time follower count captures per IG account.';
COMMENT ON COLUMN public.follower_snapshots.followers_json  IS 'Denormalised follower list. Nulled out after list_expires_at by cron.';
COMMENT ON COLUMN public.follower_snapshots.list_expires_at IS 'Set to captured_at + 30 days by trigger. Cron job cleans up after this date.';
COMMENT ON COLUMN public.follower_snapshots.is_list_complete IS 'FALSE when API pagination was cut short (e.g. rate limited mid-crawl).';

-- Trigger: keep list_expires_at = captured_at + 30 days on insert/update
CREATE OR REPLACE FUNCTION public.trg_follower_snapshots_expires()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.list_expires_at := NEW.captured_at + INTERVAL '30 days';
  RETURN NEW;
END;
$$;

CREATE TRIGGER set_list_expires_at
BEFORE INSERT OR UPDATE ON public.follower_snapshots
FOR EACH ROW EXECUTE FUNCTION public.trg_follower_snapshots_expires();

-- ── follower_edges ───────────────────────────────────────────
-- Normalised per-follower rows for a snapshot.
-- Enables efficient set-difference queries for diffs.
-- Pruned by cron when parent snapshot.list_expires_at passes.

CREATE TABLE public.follower_edges (
  id                BIGSERIAL              PRIMARY KEY,
  ig_account_id     UUID                   NOT NULL REFERENCES public.ig_accounts(id) ON DELETE CASCADE,
  snapshot_id       UUID                   NOT NULL REFERENCES public.follower_snapshots(id) ON DELETE CASCADE,
  captured_at       TIMESTAMPTZ            NOT NULL,  -- denormalised for fast range scans

  -- Follower identity
  follower_ig_id    TEXT,                  -- Instagram numeric ID (may be absent for scraped data)
  follower_username TEXT                   NOT NULL,

  created_at        TIMESTAMPTZ            NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.follower_edges IS 'Normalised per-follower rows for each snapshot. Pruned after 30 days.';
COMMENT ON COLUMN public.follower_edges.follower_ig_id IS 'NULL when data comes from a scraper that returns only usernames.';
