/// <reference path="../deno-types.d.ts" />
// status/index.ts
//
// GET /status?ig_account_id=<uuid>
//
// Returns a health summary for the given connected IG account:
//   - account status (active / token_expired / disconnected / ...)
//   - token expiry + days remaining
//   - last verified at
//   - latest snapshot summary
//   - today's manual refresh quota usage
//   - whether a re-auth is needed

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors } from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";

const MANUAL_LIMIT = 3;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    // ── 1. Auth ─────────────────────────────────────────────
    const caller = await requireAuth(req);

    // ── 2. Query param ───────────────────────────────────────
    const url = new URL(req.url);
    const igAccountId = url.searchParams.get("ig_account_id");

    if (!igAccountId) {
      // No ig_account_id: return all connected accounts for this user.
      const { data: accounts, error } = await adminClient()
        .from("ig_accounts")
        .select(
          "id, username, status, last_verified_at, token_expires_at, connected_at",
        )
        .eq("user_id", caller.userId)
        .is("deleted_at", null)
        .order("connected_at", { ascending: false });

      if (error) throw Errors.internal(error.message);
      return jsonResponse({ accounts: accounts ?? [] });
    }

    // ── 3. Ownership check ───────────────────────────────────
    await requireOwnsAccount(caller.authHeader, igAccountId);

    // ── 4. Fetch account row ─────────────────────────────────
    const { data: account, error: acctErr } = await adminClient()
      .from("ig_accounts")
      .select(
        `
          id,
          ig_user_id,
          username,
          full_name,
          profile_pic_url,
          is_business,
          status,
          token_type,
          token_expires_at,
          last_token_refresh,
          last_verified_at,
          snapshot_frequency,
          connected_at
        `,
      )
      .eq("id", igAccountId)
      .is("deleted_at", null)
      .single();

    if (acctErr || !account) throw Errors.notFound("IG account");

    // ── 5. Latest snapshot ────────────────────────────────────
    const { data: latestSnapshot } = await adminClient()
      .from("follower_snapshots")
      .select(
        "id, follower_count, following_count, post_count, captured_at, source, is_list_complete",
      )
      .eq("ig_account_id", igAccountId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // ── 6. Quota for today ─────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    const { data: quota } = await adminClient()
      .from("snapshot_quota")
      .select("manual_count")
      .eq("user_id", caller.userId)
      .eq("quota_date", today)
      .maybeSingle();

    const manualUsedToday = quota?.manual_count ?? 0;
    const manualRemainingToday = Math.max(0, MANUAL_LIMIT - manualUsedToday);

    // ── 7. Token health ───────────────────────────────────────
    const now = Date.now();
    const expiresAt = account.token_expires_at
      ? new Date(account.token_expires_at).getTime()
      : null;

    const daysUntilExpiry = expiresAt
      ? Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24))
      : null;

    const needsReauth =
      account.status === "token_expired" ||
      account.status === "suspended" ||
      (daysUntilExpiry !== null && daysUntilExpiry <= 7);

    const tokenWarning = needsReauth
      ? daysUntilExpiry !== null && daysUntilExpiry <= 0
        ? "Your Instagram session has expired. Please reconnect."
        : `Your Instagram session expires in ${daysUntilExpiry} day(s). Reconnect soon.`
      : null;

    // ── 8. Response ───────────────────────────────────────────
    return jsonResponse({
      account: {
        id: account.id,
        ig_user_id: account.ig_user_id,
        username: account.username,
        full_name: account.full_name,
        profile_pic_url: account.profile_pic_url,
        is_business: account.is_business,
        status: account.status,
        snapshot_frequency: account.snapshot_frequency,
        connected_at: account.connected_at,
        last_verified_at: account.last_verified_at,
      },
      token: {
        type: account.token_type,
        expires_at: account.token_expires_at,
        days_until_expiry: daysUntilExpiry,
        last_refreshed: account.last_token_refresh,
        needs_reauth: needsReauth,
        warning: tokenWarning,
      },
      latest_snapshot: latestSnapshot
        ? {
            id: latestSnapshot.id,
            follower_count: latestSnapshot.follower_count,
            following_count: latestSnapshot.following_count,
            post_count: latestSnapshot.post_count,
            captured_at: latestSnapshot.captured_at,
            source: latestSnapshot.source,
            is_list_complete: latestSnapshot.is_list_complete,
          }
        : null,
      quota: {
        manual_refreshes_used_today: manualUsedToday,
        manual_refreshes_remaining_today: manualRemainingToday,
        manual_limit_per_day: MANUAL_LIMIT,
        resets_at: `${today}T23:59:59Z`,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
