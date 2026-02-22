-- ============================================================
-- Migration 008 — Vault helper RPCs + quota increment helper
-- Depends on: 001–007
--
-- These SECURITY DEFINER functions are the ONLY way Edge Functions
-- can interact with Supabase Vault.  The `vault` schema is not
-- exposed to the authenticated/anon role directly.
-- ============================================================

-- ── Vault: upsert a secret ────────────────────────────────────
-- Creates a new secret or replaces an existing one by name.
-- Returns the vault secret UUID.

CREATE OR REPLACE FUNCTION public.vault_upsert_secret(
  p_name        TEXT,
  p_secret      TEXT,
  p_description TEXT DEFAULT ''
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = vault, public
AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  -- Try to find an existing secret with this name
  SELECT id INTO v_secret_id
  FROM vault.secrets
  WHERE name = p_name
  LIMIT 1;

  IF v_secret_id IS NOT NULL THEN
    -- Rotate: update the secret value in-place
    UPDATE vault.secrets
    SET    secret      = p_secret,
           description = p_description,
           updated_at  = NOW()
    WHERE  id = v_secret_id;
  ELSE
    -- Create new
    INSERT INTO vault.secrets (secret, name, description)
    VALUES (p_secret, p_name, p_description)
    RETURNING id INTO v_secret_id;
  END IF;

  RETURN v_secret_id;
END;
$$;

COMMENT ON FUNCTION public.vault_upsert_secret IS
  'Creates or rotates a Vault secret. Called by Edge Functions via service-role key only.';

-- ── Vault: retrieve a decrypted secret ───────────────────────
-- Returns the plaintext secret value for the given Vault UUID.
-- Only callable with the service-role key (function is accessible
-- to the service role but should NOT be granted to authenticated).

CREATE OR REPLACE FUNCTION public.vault_get_secret(
  p_secret_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = vault, public
AS $$
  SELECT decrypted_secret
  FROM   vault.decrypted_secrets
  WHERE  id = p_secret_id
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.vault_get_secret IS
  'Decrypts and returns a Vault secret. Service-role only.';

-- ── Vault: delete a secret ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vault_delete_secret(
  p_secret_id UUID
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = vault, public
AS $$
  DELETE FROM vault.secrets WHERE id = p_secret_id;
$$;

COMMENT ON FUNCTION public.vault_delete_secret IS
  'Deletes a Vault secret by ID. Called on account disconnect/delete.';

-- ── Quota: atomic increment ───────────────────────────────────
-- Increments either manual_count or cron_count for today's row.
-- Used by rate_limit.ts to avoid a read-modify-write race.

CREATE OR REPLACE FUNCTION public.increment_quota(
  p_user_id UUID,
  p_date    DATE,
  p_column  TEXT   -- 'manual_count' or 'cron_count'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_column NOT IN ('manual_count', 'cron_count') THEN
    RAISE EXCEPTION 'Invalid column name: %', p_column;
  END IF;

  -- Use a dynamic UPDATE to avoid two separate functions
  EXECUTE format(
    'UPDATE public.snapshot_quota
     SET %I = %I + 1
     WHERE user_id = $1 AND quota_date = $2',
    p_column, p_column
  ) USING p_user_id, p_date;

  -- If no row existed yet, upsert it now
  IF NOT FOUND THEN
    INSERT INTO public.snapshot_quota (user_id, quota_date, manual_count, cron_count)
    VALUES (
      p_user_id, p_date,
      CASE WHEN p_column = 'manual_count' THEN 1 ELSE 0 END,
      CASE WHEN p_column = 'cron_count'   THEN 1 ELSE 0 END
    )
    ON CONFLICT (user_id, quota_date) DO UPDATE
      SET manual_count = snapshot_quota.manual_count +
            CASE WHEN p_column = 'manual_count' THEN 1 ELSE 0 END,
          cron_count   = snapshot_quota.cron_count   +
            CASE WHEN p_column = 'cron_count'   THEN 1 ELSE 0 END;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.increment_quota IS
  'Atomically increments manual_count or cron_count in snapshot_quota. Race-safe.';

-- ── Restrict vault helpers to service-role only ───────────────
-- Revoke from public and authenticated; grant only to service_role.

REVOKE EXECUTE ON FUNCTION public.vault_upsert_secret FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_get_secret    FROM PUBLIC, authenticated;
REVOKE EXECUTE ON FUNCTION public.vault_delete_secret FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION public.vault_upsert_secret TO service_role;
GRANT  EXECUTE ON FUNCTION public.vault_get_secret    TO service_role;
GRANT  EXECUTE ON FUNCTION public.vault_delete_secret TO service_role;

-- increment_quota is called by Edge Functions only (service role)
REVOKE EXECUTE ON FUNCTION public.increment_quota FROM PUBLIC, authenticated;
GRANT  EXECUTE ON FUNCTION public.increment_quota TO service_role;
