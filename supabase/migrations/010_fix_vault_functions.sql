-- Migration 010 — Fix vault helper functions to use vault API (not direct INSERT)
-- The previous 008 migration wrote directly to vault.secrets, which requires
-- permission to call pgsodium internals. Use vault.create_secret /
-- vault.update_secret instead — these are the only stable public API.

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
  -- Check for an existing secret with this name
  SELECT id INTO v_secret_id
  FROM vault.secrets
  WHERE name = p_name
  LIMIT 1;

  IF v_secret_id IS NOT NULL THEN
    -- Rotate: use vault API to update
    PERFORM vault.update_secret(v_secret_id, p_secret, p_name, p_description);
  ELSE
    -- Create new via vault API
    v_secret_id := vault.create_secret(p_secret, p_name, p_description);
  END IF;

  RETURN v_secret_id;
END;
$$;

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
