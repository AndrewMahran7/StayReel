// _shared/vault.ts
// Thin wrapper around Supabase Vault RPC helpers (defined in 008_vault_helpers.sql).
// The raw session cookie NEVER leaves the service-role layer.

import { adminClient } from "./supabase_client.ts";
import { Errors } from "./errors.ts";

// Store a secret and return the Vault secret UUID.
export async function vaultStore(
  secretValue: string,
  secretName: string,
  description = "",
): Promise<string> {
  const { data, error } = await adminClient().rpc("vault_upsert_secret", {
    p_name: secretName,
    p_secret: secretValue,
    p_description: description,
  });

  if (error) throw Errors.internal(`Vault store failed: ${error.message}`);
  return data as string; // returns vault secret UUID
}

// Retrieve and decrypt a secret by its Vault UUID.
export async function vaultRetrieve(vaultSecretId: string): Promise<string> {
  const { data, error } = await adminClient().rpc("vault_get_secret", {
    p_secret_id: vaultSecretId,
  });

  if (error) throw Errors.internal(`Vault retrieve failed: ${error.message}`);
  if (!data) throw Errors.igSessionInvalid();
  return data as string;
}

// Delete a secret by Vault UUID (called on disconnect / account delete).
export async function vaultDelete(vaultSecretId: string): Promise<void> {
  const { error } = await adminClient().rpc("vault_delete_secret", {
    p_secret_id: vaultSecretId,
  });
  if (error) console.error("[vault] delete failed:", error.message);
}
