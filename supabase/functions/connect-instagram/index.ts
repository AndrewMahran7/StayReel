/// <reference path="../deno-types.d.ts" />
// connect-instagram/index.ts
//
// POST /connect-instagram
// Body: { "session_cookie": "sessionid=xxx; csrftoken=yyy" }
//
// The Instagram login happens entirely on the user device (WebView).
// This function receives the already-obtained session cookie, validates it
// by calling /accounts/current_user/, encrypts it in Supabase Vault,
// and upserts an ig_accounts row.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors } from "../_shared/errors.ts";
import { requireAuth } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";
import { writeAuditEvent, extractIp } from "../_shared/audit.ts";
import { getIgCurrentUser, assignDeviceProfile } from "../_shared/instagram.ts";
import { vaultStore, vaultDelete } from "../_shared/vault.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const { userId } = await requireAuth(req);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw Errors.badRequest("Request body must be valid JSON.");
    }

    const sessionCookie = String(body?.session_cookie ?? "").trim();
    if (!sessionCookie || !sessionCookie.includes("sessionid=")) {
      throw Errors.badRequest(
        "session_cookie is required and must include sessionid=...",
      );
    }

    const igUser = await getIgCurrentUser(sessionCookie);

    // Ensure a profiles row exists (covers users created before the trigger)
    await adminClient()
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });

    const secretName = `ig_session_${userId}_${igUser.ig_id}`;

    const { data: existingAccount } = await adminClient()
      .from("ig_accounts")
      .select("id, vault_secret_id, device_ua, device_id, android_id")
      .eq("user_id", userId)
      .eq("ig_user_id", igUser.ig_id)
      .maybeSingle();

    if (existingAccount?.vault_secret_id) {
      await vaultDelete(existingAccount.vault_secret_id);
    }

    const vaultSecretId = await vaultStore(
      sessionCookie,
      secretName,
      `IG session for user ${userId}, ig_user_id ${igUser.ig_id}`,
    );

    const tokenExpiresAt = new Date(
      Date.now() + 89 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: account, error: upsertErr } = await adminClient()
      .from("ig_accounts")
      .upsert(
        {
          id: existingAccount?.id,
          user_id: userId,
          ig_user_id: igUser.ig_id,
          username: igUser.username,
          full_name: igUser.full_name,
          profile_pic_url: igUser.profile_pic_url,
          is_business: igUser.is_business,
          vault_secret_id: vaultSecretId,
          token_type: "session_cookie",
          token_expires_at: tokenExpiresAt,
          last_token_refresh: new Date().toISOString(),
          status: "active",
          reconnect_required: false,
          last_auth_error_code: null,
          last_auth_error_message: null,
          last_auth_error_at: null,
          auto_snapshot_fail_count: 0,
          last_verified_at: new Date().toISOString(),
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          deleted_at: null,
        },
        { onConflict: "user_id,ig_user_id" },
      )
      .select("id, username, status")
      .single();

    if (upsertErr) {
      throw Errors.internal(`Failed to save IG account: ${upsertErr.message}`);
    }

    // Assign stable device fingerprint if not already present.
    // On reconnect, the existing fingerprint is preserved so Instagram
    // sees the same device identity even with a new session cookie.
    if (!existingAccount?.device_ua) {
      const dp = assignDeviceProfile();
      await adminClient()
        .from("ig_accounts")
        .update({
          device_ua:  dp.ua,
          device_id:  dp.deviceId,
          android_id: dp.androidId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", account.id);
    }

    await writeAuditEvent({
      userId,
      igAccountId: account.id,
      eventType: "account_connected",
      payload: {
        ig_user_id: igUser.ig_id,
        username: igUser.username,
        token_expires_at: tokenExpiresAt,
      },
      ipAddress: extractIp(req),
    });

    return jsonResponse({
      ig_account_id: account.id,
      username: account.username,
      status: account.status,
      token_expires_at: tokenExpiresAt,
      message: "Instagram account connected successfully.",
    });
  } catch (err) {
    return errorResponse(err);
  }
});
