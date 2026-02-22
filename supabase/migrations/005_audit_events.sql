-- ============================================================
-- Migration 005 — audit_events
-- Depends on: 001_profiles.sql
-- ============================================================

-- ── audit_events ─────────────────────────────────────────────
-- Immutable append-only log of security-relevant and
-- user-visible events. Written by Edge Functions only
-- (service role key). Never updated or deleted by app logic.
-- Retained for 90 days then archived/pruned by cron.

CREATE TABLE public.audit_events (
  id              BIGSERIAL                  PRIMARY KEY,

  -- Actor — may be NULL for system/cron-initiated events
  user_id         UUID                       REFERENCES public.profiles(id) ON DELETE SET NULL,
  ig_account_id   UUID                       REFERENCES public.ig_accounts(id) ON DELETE SET NULL,

  event_type      public.audit_event_type    NOT NULL,

  -- Arbitrary structured context for the event.
  -- Keep PII minimal: store ig_user_id strings, never raw tokens.
  payload         JSONB                      NOT NULL DEFAULT '{}'::JSONB,

  -- Original client IP (from Edge Function request headers)
  ip_address      INET,

  -- User-Agent or 'cron' / 'edge_function'
  source          TEXT,

  created_at      TIMESTAMPTZ                NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.audit_events IS 'Immutable security and activity log. Written by Edge Functions via service-role key only.';
COMMENT ON COLUMN public.audit_events.payload IS 'Event-specific JSON context. Must not contain raw tokens or passwords.';
COMMENT ON COLUMN public.audit_events.ip_address IS 'Request IP forwarded from Edge Function. May be NULL for cron events.';

-- ── Example payload shapes by event_type ─────────────────────
--
-- account_connected:   { "ig_user_id": "123", "username": "alice" }
-- account_disconnected:{ "ig_user_id": "123", "reason": "user_initiated" }
-- snapshot_taken:      { "snapshot_id": "uuid", "follower_count": 1024, "source": "cron" }
-- snapshot_failed:     { "ig_account_id": "uuid", "error": "token_expired" }
-- token_refreshed:     { "ig_account_id": "uuid", "new_expires_at": "2026-04-20T00:00:00Z" }
-- rate_limit_hit:      { "ig_account_id": "uuid", "limit_type": "manual_quota", "count": 3 }
-- notification_sent:   { "push_token": "ExponentPushToken[...]", "event": "unfollow", "count": 2 }
-- user_deleted:        { "deleted_at": "2026-02-20T00:00:00Z", "method": "self_service" }
