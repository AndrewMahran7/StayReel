-- ============================================================
-- Migration 007 — Indexes, triggers, and utility functions
-- Depends on: 001–006
-- ============================================================

-- ════════════════════════════════════════════════════════════
-- Indexes
-- ════════════════════════════════════════════════════════════

-- ── profiles ─────────────────────────────────────────────────
-- Fast lookup of non-deleted users (used by cron jobs)
CREATE INDEX idx_profiles_active
  ON public.profiles (id)
  WHERE deleted_at IS NULL;

-- ── ig_accounts ──────────────────────────────────────────────
-- All active accounts for a user (most common client query)
CREATE INDEX idx_ig_accounts_user_active
  ON public.ig_accounts (user_id, status)
  WHERE deleted_at IS NULL;

-- Token expiry sweep (used by refresh-token cron)
CREATE INDEX idx_ig_accounts_token_expiry
  ON public.ig_accounts (token_expires_at)
  WHERE status = 'active' AND deleted_at IS NULL;

-- Lookup by IG user ID (deduplication check on connect)
CREATE INDEX idx_ig_accounts_ig_user_id
  ON public.ig_accounts (ig_user_id);

-- ── snapshot_quota ────────────────────────────────────────────
CREATE INDEX idx_snapshot_quota_user_date
  ON public.snapshot_quota (user_id, quota_date);

-- ── follower_snapshots ────────────────────────────────────────
-- Most common query: latest N snapshots for an account
CREATE INDEX idx_snapshots_account_time
  ON public.follower_snapshots (ig_account_id, captured_at DESC);

-- Cron cleanup: find old snapshots whose list_expires_at has passed
CREATE INDEX idx_snapshots_expiry
  ON public.follower_snapshots (list_expires_at)
  WHERE followers_json IS NOT NULL;

-- ── follower_edges ────────────────────────────────────────────
-- Set-difference queries comparing two captures
CREATE INDEX idx_edges_snapshot
  ON public.follower_edges (snapshot_id);

-- Composite for per-account range scans
CREATE INDEX idx_edges_account_time
  ON public.follower_edges (ig_account_id, captured_at DESC);

-- Username lookup within a snapshot (diff computation)
CREATE INDEX idx_edges_username
  ON public.follower_edges (snapshot_id, follower_username);

-- Partial index: only rows with a numeric IG ID (for join-based diffs)
CREATE INDEX idx_edges_ig_id
  ON public.follower_edges (snapshot_id, follower_ig_id)
  WHERE follower_ig_id IS NOT NULL;

-- ── diffs ─────────────────────────────────────────────────────
-- Latest diff for an account (dashboard + notifications)
CREATE INDEX idx_diffs_account_time
  ON public.diffs (ig_account_id, to_captured_at DESC);

-- Covering index for the diff detail screen
CREATE INDEX idx_diffs_snapshots
  ON public.diffs (from_snapshot_id, to_snapshot_id);

-- ── audit_events ──────────────────────────────────────────────
-- Per-user event timeline (settings screen)
CREATE INDEX idx_audit_user_time
  ON public.audit_events (user_id, created_at DESC);

-- Per-account event timeline (admin / support tooling)
CREATE INDEX idx_audit_account_time
  ON public.audit_events (ig_account_id, created_at DESC)
  WHERE ig_account_id IS NOT NULL;

-- Cron cleanup: prune events older than 90 days
CREATE INDEX idx_audit_created_at
  ON public.audit_events (created_at);


-- ════════════════════════════════════════════════════════════
-- Triggers: auto-maintained updated_at columns
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_ig_accounts_updated_at
  BEFORE UPDATE ON public.ig_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ════════════════════════════════════════════════════════════
-- Trigger: auto-create profile + settings on user sign-up
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER           -- runs as table owner, not as the new user
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.user_settings (user_id)
  VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

COMMENT ON FUNCTION public.handle_new_user IS
  'Automatically provisions profiles + user_settings rows when a new Supabase Auth user is created.';


-- ════════════════════════════════════════════════════════════
-- Utility function: get latest two snapshots for diff computation
-- Called by take-snapshot Edge Function via RPC.
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_snapshot_pair(p_ig_account_id UUID)
RETURNS TABLE (
  newer_id          UUID,
  newer_captured_at TIMESTAMPTZ,
  older_id          UUID,
  older_captured_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    a.id            AS newer_id,
    a.captured_at   AS newer_captured_at,
    b.id            AS older_id,
    b.captured_at   AS older_captured_at
  FROM (
    SELECT id, captured_at
    FROM   public.follower_snapshots
    WHERE  ig_account_id = p_ig_account_id
    ORDER BY captured_at DESC
    LIMIT 2
  ) sub
  -- pivot into two columns
  JOIN LATERAL (VALUES (1)) v(n) ON TRUE
  -- self-join trick: row 1 = newer, row 2 = older
  CROSS JOIN LATERAL (
    SELECT id, captured_at FROM public.follower_snapshots
    WHERE  ig_account_id = p_ig_account_id
    ORDER BY captured_at DESC
    LIMIT 1 OFFSET 1
  ) b
  JOIN LATERAL (
    SELECT id, captured_at FROM public.follower_snapshots
    WHERE  ig_account_id = p_ig_account_id
    ORDER BY captured_at DESC
    LIMIT 1 OFFSET 0
  ) a ON TRUE
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_snapshot_pair IS
  'Returns the two most recent snapshot IDs for an IG account. Used by Edge Function to compute diffs.';


-- ════════════════════════════════════════════════════════════
-- Cron job definitions (via pg_cron — enable in Supabase dashboard)
-- ════════════════════════════════════════════════════════════

-- Prune expired follower lists (runs at 03:00 UTC daily)
-- SELECT cron.schedule(
--   'prune-expired-follower-lists',
--   '0 3 * * *',
--   $$
--     UPDATE public.follower_snapshots
--     SET    followers_json = NULL
--     WHERE  list_expires_at < NOW()
--       AND  followers_json IS NOT NULL;
--
--     DELETE FROM public.follower_edges
--     WHERE  snapshot_id IN (
--       SELECT id FROM public.follower_snapshots
--       WHERE  list_expires_at < NOW()
--     );
--   $$
-- );

-- Prune audit events older than 90 days (runs at 04:00 UTC daily)
-- SELECT cron.schedule(
--   'prune-old-audit-events',
--   '0 4 * * *',
--   $$
--     DELETE FROM public.audit_events
--     WHERE created_at < NOW() - INTERVAL '90 days';
--   $$
-- );

-- Hard-delete soft-deleted profiles older than 30 days (runs at 05:00 UTC daily)
-- SELECT cron.schedule(
--   'hard-delete-profiles',
--   '0 5 * * *',
--   $$
--     DELETE FROM public.profiles
--     WHERE deleted_at < NOW() - INTERVAL '30 days';
--   $$
-- );
