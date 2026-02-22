-- ============================================================
-- Migration 006 — Row Level Security policies
-- Depends on: 001–005
-- ============================================================
-- Design rules:
--   • Users can only SELECT/INSERT/UPDATE/DELETE their own rows.
--   • ig_accounts are owned by user_id.
--   • Snapshots, edges, and diffs are owned transitively
--     through ig_accounts.user_id.
--   • audit_events are INSERT-only from service role (Edge
--     Functions); users may SELECT their own rows but never
--     modify them.
--   • No policy grants cross-user data access.
-- ─────────────────────────────────────────────────────────────

-- ── Enable RLS on every table ─────────────────────────────────

ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_quota     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_edges     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.diffs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events       ENABLE ROW LEVEL SECURITY;

-- ── Helper: reusable inline subquery ─────────────────────────
-- Returns true if ig_account_id belongs to the requesting user.
-- Used in policies below to avoid repeating the join.

CREATE OR REPLACE FUNCTION public.owns_ig_account(p_ig_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.ig_accounts
    WHERE id = p_ig_account_id
      AND user_id = auth.uid()
      AND deleted_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.owns_ig_account IS
  'Returns TRUE when the current auth user owns the given ig_account_id. Used in RLS policies.';

-- ════════════════════════════════════════════════════════════
-- profiles
-- ════════════════════════════════════════════════════════════

CREATE POLICY "profiles: own row only"
  ON public.profiles
  FOR ALL
  USING  (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ════════════════════════════════════════════════════════════
-- user_settings
-- ════════════════════════════════════════════════════════════

CREATE POLICY "user_settings: own row only"
  ON public.user_settings
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════
-- ig_accounts
-- ════════════════════════════════════════════════════════════

CREATE POLICY "ig_accounts: own accounts only"
  ON public.ig_accounts
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════
-- snapshot_quota
-- ════════════════════════════════════════════════════════════

CREATE POLICY "snapshot_quota: own row only"
  ON public.snapshot_quota
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════
-- follower_snapshots
-- ════════════════════════════════════════════════════════════

-- SELECT: user can read snapshots that belong to their ig_accounts
CREATE POLICY "snapshots: select own"
  ON public.follower_snapshots
  FOR SELECT
  USING (public.owns_ig_account(ig_account_id));

-- INSERT/UPDATE/DELETE: only via service-role (Edge Functions).
-- Authenticated users cannot write snapshots directly.
-- No INSERT/UPDATE/DELETE policy = row-level deny for anon/auth roles.

-- ════════════════════════════════════════════════════════════
-- follower_edges
-- ════════════════════════════════════════════════════════════

CREATE POLICY "edges: select own"
  ON public.follower_edges
  FOR SELECT
  USING (public.owns_ig_account(ig_account_id));

-- ════════════════════════════════════════════════════════════
-- diffs
-- ════════════════════════════════════════════════════════════

CREATE POLICY "diffs: select own"
  ON public.diffs
  FOR SELECT
  USING (public.owns_ig_account(ig_account_id));

-- ════════════════════════════════════════════════════════════
-- audit_events
-- ════════════════════════════════════════════════════════════

-- Users can read only their own audit events
CREATE POLICY "audit: select own"
  ON public.audit_events
  FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE for authenticated role —
-- all writes go through Edge Functions with service-role key.

-- ─────────────────────────────────────────────────────────────
-- Grant usage on schema to authenticated role
-- (Supabase default — included here for completeness)
-- ─────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO authenticated;

GRANT SELECT                    ON public.profiles           TO authenticated;
GRANT UPDATE (display_name, avatar_url, push_token, updated_at)
                                ON public.profiles           TO authenticated;
GRANT SELECT, INSERT, UPDATE    ON public.user_settings      TO authenticated;
GRANT SELECT                    ON public.ig_accounts        TO authenticated;
GRANT SELECT                    ON public.snapshot_quota     TO authenticated;
GRANT SELECT                    ON public.follower_snapshots TO authenticated;
GRANT SELECT                    ON public.follower_edges     TO authenticated;
GRANT SELECT                    ON public.diffs              TO authenticated;
GRANT SELECT                    ON public.audit_events       TO authenticated;
