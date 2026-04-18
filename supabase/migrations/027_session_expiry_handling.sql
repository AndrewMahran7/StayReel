-- Migration 027: Session expiry handling
--
-- Adds reconnect_required flag and auth error tracking to ig_accounts.
-- Enables the snapshot pipeline to block jobs when Instagram auth is expired
-- and track exactly why + when the auth failure occurred.

-- ── ig_accounts: reconnect state ──────────────────────────────────────────
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS reconnect_required boolean NOT NULL DEFAULT false;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS last_auth_error_code text;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS last_auth_error_message text;
ALTER TABLE ig_accounts ADD COLUMN IF NOT EXISTS last_auth_error_at timestamptz;

-- Index for scheduler/job queries that filter by reconnect_required
CREATE INDEX IF NOT EXISTS idx_ig_accounts_reconnect ON ig_accounts (reconnect_required) WHERE reconnect_required = true;

-- When an account is successfully reconnected (cookie re-saved, status back to 'active'),
-- clear the reconnect state. This is done by the connect-instagram function, but we also
-- provide a convenience function for manual resets.
COMMENT ON COLUMN ig_accounts.reconnect_required IS 'True when Instagram auth has expired mid-job and the user must reconnect. Cleared on successful reconnect.';
COMMENT ON COLUMN ig_accounts.last_auth_error_code IS 'Classified error code from the last auth failure (e.g. session_expired, checkpoint_or_challenge).';
COMMENT ON COLUMN ig_accounts.last_auth_error_message IS 'Human-readable description of the last auth failure.';
COMMENT ON COLUMN ig_accounts.last_auth_error_at IS 'Timestamp of the last auth failure detection.';
