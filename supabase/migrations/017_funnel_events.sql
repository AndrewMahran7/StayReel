-- ============================================================
-- Migration 017 — Funnel analytics events
-- Lightweight client-side event tracking for freemium funnel
-- analysis. Separate from audit_events (service-role only) so
-- the authenticated client can INSERT directly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.funnel_events (
  id          BIGSERIAL    PRIMARY KEY,
  user_id     UUID         NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_name  TEXT         NOT NULL,
  payload     JSONB,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.funnel_events
  IS 'Client-side funnel analytics. INSERT via authenticated user, read via service role or own rows.';
COMMENT ON COLUMN public.funnel_events.event_name
  IS 'Free-text event name — e.g. snapshot_started, upgrade_cta_clicked, paywall_opened.';
COMMENT ON COLUMN public.funnel_events.payload
  IS 'Arbitrary JSON context: list type, item counts, subscription tier, etc.';

-- Index for time-range funnel queries
CREATE INDEX IF NOT EXISTS idx_funnel_events_created
  ON public.funnel_events (created_at DESC);

-- Index for per-user event history
CREATE INDEX IF NOT EXISTS idx_funnel_events_user
  ON public.funnel_events (user_id, created_at DESC);

-- Index for event-name aggregation
CREATE INDEX IF NOT EXISTS idx_funnel_events_name
  ON public.funnel_events (event_name, created_at DESC);

-- ── RLS ─────────────────────────────────────────────────────────
ALTER TABLE public.funnel_events ENABLE ROW LEVEL SECURITY;

-- Authenticated users can INSERT their own events
CREATE POLICY funnel_events_insert ON public.funnel_events
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- Users can read their own events (optional, for debugging)
CREATE POLICY funnel_events_select ON public.funnel_events
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- No UPDATE or DELETE — events are append-only
