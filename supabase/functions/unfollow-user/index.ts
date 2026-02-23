/// <reference path="../deno-types.d.ts" />
// unfollow-user/index.ts
//
// POST /unfollow-user
// Body: { "ig_account_id": "<uuid>", "target_ig_id": "<instagram numeric id>" }
//
// Unfollows the target account on Instagram using the stored session cookie.
// Only the `not_following_back` use-case is expected, but the endpoint is
// generic — the caller decides which accounts to pass.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors }                from "../_shared/errors.ts";
import { requireAuth }                          from "../_shared/auth.ts";
import { adminClient }                          from "../_shared/supabase_client.ts";
import { vaultRetrieve }                        from "../_shared/vault.ts";

const IG_API    = "https://i.instagram.com/api/v1";
const IG_APP_ID = "936619743392459";
const USER_AGENT =
  "Instagram 314.0.0.35.109 Android (26/8.0.0; 480dpi; 1080x1920; " +
  "OnePlus; ONEPLUS A5000; OnePlus5; qcom; en_US; 556543836)";

function extractCsrf(cookie: string): string {
  return cookie.match(/csrftoken=([^;\s]+)/)?.[1] ?? "";
}

function buildHeaders(cookie: string): HeadersInit {
  return {
    "User-Agent":             USER_AGENT,
    "Cookie":                 cookie,
    "X-CSRFToken":            extractCsrf(cookie),
    "X-IG-App-ID":            IG_APP_ID,
    "X-IG-Capabilities":      "3brTvwE=",
    "X-IG-Connection-Type":   "WIFI",
    "Accept-Language":        "en-US",
    "Accept":                 "application/json",
    "Content-Type":           "application/x-www-form-urlencoded",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    // ── 1. Auth ───────────────────────────────────────────────
    const caller = await requireAuth(req);

    // ── 2. Parse body ─────────────────────────────────────────
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { throw Errors.badRequest("Invalid JSON body"); }

    const igAccountId = body.ig_account_id as string | undefined;
    const targetIgId  = body.target_ig_id  as string | undefined;

    if (!igAccountId) throw Errors.badRequest("ig_account_id is required");
    if (!targetIgId)  throw Errors.badRequest("target_ig_id is required");

    // ── 3. Ownership check ────────────────────────────────────
    const { data: account, error: accountErr } = await adminClient()
      .from("ig_accounts")
      .select("id, user_id, ig_user_id, vault_secret_id, status")
      .eq("id", igAccountId)
      .is("deleted_at", null)
      .single();

    if (accountErr || !account) throw Errors.notFound("ig_account");
    if (account.user_id !== caller.userId) throw Errors.forbidden();
    if (account.status === "token_expired") {
      throw Errors.igSessionInvalid();
    }

    // ── 4. Get session cookie from Vault ──────────────────────
    const cookie = await vaultRetrieve(account.vault_secret_id);

    // ── 5. Call Instagram unfollow API ────────────────────────
    const url = `${IG_API}/friendships/destroy/${targetIgId}/`;

    const formBody = new URLSearchParams({
      _uuid:        crypto.randomUUID(),
      user_id:      targetIgId,
      radio_type:   "wifi-none-1",
      _uid:         account.ig_user_id,
      device_id:    crypto.randomUUID(),
    });

    const res = await fetch(url, {
      method:  "POST",
      headers: buildHeaders(cookie),
      body:    formBody.toString(),
    });

    // Handle Instagram-level errors
    if (res.status === 401) {
      await adminClient()
        .from("ig_accounts")
        .update({ status: "token_expired" })
        .eq("id", igAccountId);
      throw Errors.igSessionInvalid();
    }

    if (res.status === 429) throw Errors.igRateLimit();

    if (!res.ok) {
      let detail: unknown;
      try { detail = await res.json(); } catch { detail = null; }
      const msg = String((detail as Record<string, unknown>)?.message ?? "")
        .toLowerCase();
      if (msg.includes("challenge")) throw Errors.igChallenge();
      throw Errors.internal(`Instagram returned ${res.status}`);
    }

    // Parse response — Instagram returns { friendship_status: { ... } }
    let igData: Record<string, unknown> = {};
    try { igData = await res.json(); } catch { /* ignore */ }

    return jsonResponse({
      success: true,
      friendship_status: (igData as Record<string, unknown>).friendship_status ?? null,
    });

  } catch (err) {
    return errorResponse(err);
  }
});
