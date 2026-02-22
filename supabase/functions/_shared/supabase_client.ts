/// <reference path="../deno-types.d.ts" />
// _shared/supabase_client.ts
// Creates Supabase client instances for Edge Functions.

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── User-scoped client (RLS enforced) ─────────────────────────
// Pass the caller's JWT so RLS policies run as that user.
export function createUserClient(authHeader: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
}

// ── Service-role client (bypasses RLS) ───────────────────────
// Used only for privileged writes (snapshots, diffs, audit, vault).
let _adminClient: SupabaseClient | null = null;
export function adminClient(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _adminClient;
}
