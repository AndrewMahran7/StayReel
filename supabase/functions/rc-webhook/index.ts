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
      // IMPORTANT: unknown event types must NOT silently grant Pro.
      // Log a warning so we can add explicit handling when RC adds new events.
      console.warn(`[rc-webhook] Unmapped event type "${type}" — defaulting to "free"`);
      return "free";
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

  // ── 3b. Protect promo-granted access ──────────────────────────
  // If the user has an active promo (promo_until in the future), a
  // downgrade event from RC (EXPIRATION, CANCELLATION, etc.) must NOT
  // overwrite their Pro access. We only allow RC upgrades through.
  const db = adminClient();

  const { data: currentProfile } = await db
    .from("profiles")
    .select("promo_until")
    .eq("id", userId)
    .maybeSingle();

  const promoActive =
    currentProfile?.promo_until &&
    new Date(currentProfile.promo_until) > new Date();

  if (promoActive && subscriptionStatus !== "active" && subscriptionStatus !== "trial") {
    console.log(
      `[rc-webhook] Skipping downgrade for user ${userId} — active promo until ${currentProfile.promo_until}`,
    );
    return jsonResponse({ ok: true, skipped: "active_promo" });
  }

  // If this is a real subscription activation, clear the promo fields
  // so the user cleanly transitions to a paid plan.
  const clearPromo =
    (subscriptionStatus === "active" || subscriptionStatus === "trial") && promoActive;

  // ── 4. Persist to profiles ─────────────────────────────────────
  const updatePayload: Record<string, unknown> = {
    subscription_status:     subscriptionStatus,
    subscription_expires_at: subscriptionExpiresAt,
    rc_customer_id:          event.original_app_user_id || userId,
  };
  if (clearPromo) {
    updatePayload.promo_code_id = null;
    updatePayload.promo_until   = null;
  }

  const { error } = await db
    .from("profiles")
    .update(updatePayload)
    .eq("id", userId);

  if (error) {
    console.error("[rc-webhook] DB update failed:", error.message);
    return jsonResponse({ error: "DB update failed" }, 500);
  }

  console.log(`[rc-webhook] Updated profile ${userId}: status=${subscriptionStatus}, expires=${subscriptionExpiresAt}`);

  return jsonResponse({ ok: true });
});
