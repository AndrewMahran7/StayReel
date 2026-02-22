/// <reference path="../deno-types.d.ts" />
// admin-reset-quota/index.ts — dev-only helper
import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  const caller = await requireAuth(req);
  const today = new Date().toISOString().slice(0, 10);

  // Reset quota
  await adminClient()
    .from("snapshot_quota")
    .update({ manual_count: 0 })
    .eq("user_id", caller.userId)
    .eq("quota_date", today);

  // Delete all diffs for this user's ig accounts
  const { data: accounts } = await adminClient()
    .from("ig_accounts")
    .select("id")
    .eq("user_id", caller.userId);

  if (accounts && accounts.length > 0) {
    const ids = accounts.map((a: { id: string }) => a.id);
    await adminClient().from("diffs").delete().in("ig_account_id", ids);
    await adminClient().from("follower_edges").delete().in("ig_account_id", ids);
    await adminClient().from("follower_snapshots").delete().in("ig_account_id", ids);
  }

  return jsonResponse({ ok: true, reset_for: today, accounts_cleaned: accounts?.length ?? 0 });
});
