/// <reference path="../deno-types.d.ts" />
// rc-webhook/index.ts
//
// POST /rc-webhook
// RevenueCat Server-to-Server webhook.
// Receives subscription lifecycle events and updates the profiles table.
//
// Authenticated via the `Authorization: Bearer <RC_WEBHOOK_SECRET>` header —
// set the same value both in RevenueCat dashboard and in Supabase Vault.

import { jsonResponse }  from "../_shared/cors.ts";
import { adminClient }   from "../_shared/supabase_client.ts";

// ── Types for the RevenueCat webhook payload ────────────────────
type RCEventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "CANCELLATION"
  | "UNCANCELLATION"
  | "BILLING_ISSUE"
  | "SUBSCRIBER_ALIAS"
  | "PRODUCT_CHANGE"
  | "EXPIRATION"
  | "TRANSFER"
  | "NON_RENEWING_PURCHASE"
  | "SUBSCRIPTION_PAUSED"
  | "SUBSCRIPTION_EXTENDED"
  | "TEST";

interface RCEvent {
  type:                  RCEventType;
  app_user_id:           string;   // The Supabase user id (our RC appUserID)
  original_app_user_id:  string;
  product_id:            string;
  entitlement_ids:       string[] | null;
  expiration_at_ms:      number | null;
  event_timestamp_ms:    number;
  is_trial_conversion?:  boolean;
  period_type?:          string;   // "TRIAL" | "NORMAL" | "INTRO"
}

interface RCWebhookBody {
  api_version: string;
  event:       RCEvent;
}

// ── Helpers ──────────────────────────────────────────────────────

function mapStatus(event: RCEvent): string {
  const { type, period_type } = event;

  switch (type) {
    case "INITIAL_PURCHASE":
      return period_type === "TRIAL" ? "trial" : "active";
    case "RENEWAL":
    case "UNCANCELLATION":
    case "SUBSCRIPTION_EXTENDED":
      return "active";
    case "CANCELLATION":
      return "cancelled";
    case "EXPIRATION":
      return "expired";
    case "BILLING_ISSUE":
      return "expired";          // treat billing issue as expired until resolved
    default:
      return "active";           // safe fallback
  }
}

// ── Main handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── 1. Authenticate via shared secret ─────────────────────────
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  const secret = Deno.env.get("RC_WEBHOOK_SECRET");
  if (!secret || token !== secret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // ── 2. Parse the event ────────────────────────────────────────
  let body: RCWebhookBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const event = body.event;
  if (!event || !event.type) {
    return jsonResponse({ error: "Missing event" }, 400);
  }

  // Ignore test events in production
  if (event.type === "TEST") {
    console.log("[rc-webhook] Received TEST event — acknowledged.");
    return jsonResponse({ ok: true });
  }

  const userId = event.app_user_id;
  if (!userId) {
    return jsonResponse({ error: "Missing app_user_id" }, 400);
  }

  console.log(`[rc-webhook] ${event.type} for user ${userId}, product=${event.product_id}`);

  // ── 3. Compute updates ─────────────────────────────────────────
  const subscriptionStatus = mapStatus(event);
  const subscriptionExpiresAt = event.expiration_at_ms
    ? new Date(event.expiration_at_ms).toISOString()
    : null;

  // ── 4. Persist to profiles ─────────────────────────────────────
  const db = adminClient();
  const { error } = await db
    .from("profiles")
    .update({
      subscription_status:     subscriptionStatus,
      subscription_expires_at: subscriptionExpiresAt,
      rc_customer_id:          event.original_app_user_id || userId,
    })
    .eq("id", userId);

  if (error) {
    console.error("[rc-webhook] DB update failed:", error.message);
    return jsonResponse({ error: "DB update failed" }, 500);
  }

  console.log(`[rc-webhook] Updated profile ${userId}: status=${subscriptionStatus}, expires=${subscriptionExpiresAt}`);

  return jsonResponse({ ok: true });
});
