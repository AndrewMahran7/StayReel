/// <reference path="../deno-types.d.ts" />
// snapshot-history/index.ts
//
// GET /snapshot-history?ig_account_id=<uuid>&days=7
//
// Returns an ordered array of snapshot data points for the growth chart.
// Response: { snapshots: Array<{ captured_at, follower_count, following_count, mutual_count }> }

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors } from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireAuth(req);
    const url    = new URL(req.url);

    const igAccountId = url.searchParams.get("ig_account_id");
    if (!igAccountId) throw Errors.badRequest("ig_account_id is required.");
    await requireOwnsAccount(caller.authHeader, igAccountId);

    const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "7", 10), 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();

    const { data, error } = await adminClient()
      .from("follower_snapshots")
      .select("captured_at, follower_count, following_count, mutual_count")
      .eq("ig_account_id", igAccountId)
      .gte("captured_at", since)
      .order("captured_at", { ascending: true });

    if (error) throw Errors.internal(error.message);

    return jsonResponse({ snapshots: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
});
