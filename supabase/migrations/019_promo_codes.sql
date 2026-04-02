-- 019_promo_codes.sql
-- Promo codes that grant free Pro access until a specified date.
-- Managed via SQL / Supabase Dashboard — never exposed to the client directly.

CREATE TABLE IF NOT EXISTS promo_codes (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  code             text NOT NULL UNIQUE,
  -- NULL = unlimited redemptions; otherwise decremented on each use.
  max_redemptions  int,
  times_redeemed   int NOT NULL DEFAULT 0,
  -- The date until which the redeemer gets Pro access.
  grants_until     timestamptz NOT NULL,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  note             text  -- internal memo (e.g. "Beta testers March 2026")
);

-- Track which users redeemed which codes (audit + prevent double-redeem).
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  promo_code_id uuid NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  redeemed_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, promo_code_id)
);

-- Index for quick lookup during redemption
CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes (code);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions (user_id);

-- Add promo tracking columns to profiles so we can distinguish promo-granted
-- access from real subscriptions (prevents rc-webhook from overwriting promo).
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS promo_code_id  uuid REFERENCES promo_codes(id),
  ADD COLUMN IF NOT EXISTS promo_until    timestamptz;

-- Atomic increment function used by the redeem-promo edge function.
CREATE OR REPLACE FUNCTION increment_promo_redemptions(promo_id uuid)
RETURNS void AS $$
  UPDATE promo_codes
  SET times_redeemed = times_redeemed + 1
  WHERE id = promo_id;
$$ LANGUAGE sql VOLATILE SECURITY DEFINER;

-- Server-time helper (used by client for tamper-resistant date checks).
CREATE OR REPLACE FUNCTION get_server_time()
RETURNS timestamptz AS $$
  SELECT now();
$$ LANGUAGE sql STABLE;

-- RLS: promo_codes readable by authenticated users (for validation),
-- but only service-role can INSERT/UPDATE/DELETE.
ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "promo_codes_select" ON promo_codes FOR SELECT TO authenticated USING (true);

-- RLS: promo_redemptions — users can read their own redemptions.
ALTER TABLE promo_redemptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "promo_redemptions_select_own" ON promo_redemptions FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ═══════════════════════════════════════════════════════════════
-- ADMIN CHEAT SHEET  (run in Supabase SQL Editor, never from client)
-- ═══════════════════════════════════════════════════════════════
--
-- ── Create a single-use code giving Pro until June 1 2026 ────
-- INSERT INTO promo_codes (code, max_redemptions, grants_until, note)
-- VALUES ('BETA2026', 1, '2026-06-01T00:00:00Z', 'Single beta tester');
--
-- ── Create an unlimited-use code for a class/group ───────────
-- INSERT INTO promo_codes (code, max_redemptions, grants_until, note)
-- VALUES ('CLASSFREE', NULL, '2026-09-01T00:00:00Z', 'Summer promo for everyone');
--
-- ── Create a 50-use code ─────────────────────────────────────
-- INSERT INTO promo_codes (code, max_redemptions, grants_until, note)
-- VALUES ('LAUNCH50', 50, '2026-12-31T00:00:00Z', 'First 50 users from launch');
--
-- ── Deactivate a code (stops new redemptions; existing users keep access) ──
-- UPDATE promo_codes SET is_active = false WHERE code = 'BETA2026';
--
-- ── See who redeemed a code ──────────────────────────────────
-- SELECT r.redeemed_at, p.email
-- FROM promo_redemptions r
-- JOIN auth.users p ON p.id = r.user_id
-- JOIN promo_codes c ON c.id = r.promo_code_id
-- WHERE c.code = 'BETA2026';
--
-- ── Revoke promo access for a specific user ──────────────────
-- UPDATE profiles
-- SET subscription_status = 'free',
--     subscription_expires_at = NULL,
--     promo_code_id = NULL,
--     promo_until = NULL,
--     updated_at = now()
-- WHERE id = '<user-id>';
