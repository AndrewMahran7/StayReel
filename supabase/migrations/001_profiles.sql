-- ============================================================
-- Migration 001 — Custom types + profiles table
-- Run order: first
-- ============================================================

-- ── Custom enum types ────────────────────────────────────────

CREATE TYPE public.ig_account_status AS ENUM (
  'pending',       -- OAuth started but not yet verified
  'active',        -- token valid, snapshots running
  'token_expired', -- long-lived token needs re-auth
  'disconnected',  -- user manually disconnected
  'suspended'      -- flagged for TOS / rate-limit abuse
);

CREATE TYPE public.snapshot_source AS ENUM (
  'cron',          -- scheduled automatic capture
  'manual',        -- user pressed "Refresh Now"
  'onboarding'     -- first capture after connecting account
);

CREATE TYPE public.audit_event_type AS ENUM (
  'account_connected',
  'account_disconnected',
  'account_deleted',
  'snapshot_taken',
  'snapshot_failed',
  'token_refreshed',
  'token_expired',
  'rate_limit_hit',
  'notification_sent',
  'user_deleted'
);

-- ── Profiles ─────────────────────────────────────────────────
-- Extends Supabase Auth (auth.users). Created automatically
-- via trigger on auth.users INSERT (see 007_functions.sql).

CREATE TABLE public.profiles (
  id            UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,
  avatar_url    TEXT,
  -- Expo Push Notification token (rotated by client on each launch)
  push_token    TEXT,
  -- Soft-delete: set by delete-account edge function; hard-delete by cron after 30 days
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.profiles IS 'One row per authenticated user. Mirrors auth.users with app-specific fields.';
COMMENT ON COLUMN public.profiles.push_token IS 'Expo push token, updated client-side on each app launch.';
COMMENT ON COLUMN public.profiles.deleted_at IS 'Soft-delete timestamp. Hard-delete occurs 30 days later via cron.';

-- ── User settings ────────────────────────────────────────────

CREATE TABLE public.user_settings (
  user_id                UUID        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  notify_on_unfollow     BOOLEAN     NOT NULL DEFAULT TRUE,
  notify_on_new_follower BOOLEAN     NOT NULL DEFAULT FALSE,
  notify_on_token_expiry BOOLEAN     NOT NULL DEFAULT TRUE,
  snapshot_frequency     TEXT        NOT NULL DEFAULT 'daily'
                         CHECK (snapshot_frequency IN ('hourly', 'daily')),
  -- GDPR / CCPA consent recorded at signup
  gdpr_consent_at        TIMESTAMPTZ,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.user_settings IS 'Per-user app preferences. Row created alongside profiles row.';
