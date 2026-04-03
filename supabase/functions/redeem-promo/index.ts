/// <reference path="../deno-types.d.ts" />
// redeem-promo/index.ts
//
// POST /redeem-promo  { code: string }
//
// Validates a promo code and grants the caller free Pro access until the
// code's `grants_until` date.  Stamps both profile subscription fields
// AND dedicated promo fields so the rc-webhook doesn't overwrite it.
//
// Error codes (in `error` field):
//   "bad_request"       – missing or malformed code
//   "code_not_found"    – no such code
//   "code_expired"      – grants_until is in the past
//   "code_exhausted"    – max_redemptions reached
//   "code_inactive"     – manually deactivated
//   "already_redeemed"  – this user already redeemed this code
//   "already_pro"       – user has an active RC subscription (no need for promo)

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, AppError, Errors }     from "../_shared/errors.ts";
import { requireAuth }                         from "../_shared/auth.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";

/** Case-insensitive alphanumeric + dash/underscore, 2-40 chars. */
const CODE_RE = /^[a-z0-9_-]{2,40}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const caller = await requireAuth(req);
    const db     = adminClient();

    // ── Parse & validate input ───────────────────────────────
    let body: { code?: string };
    try {
      body = await req.json();
    } catch {
      throw Errors.badRequest("Invalid JSON body.");
    }

    // Normalise to UPPERCASE — promo codes are stored uppercase by
    // convention (see migration 019). This ensures "beta2026" entered
    // by the user matches "BETA2026" in the database.
    const rawCode = (body.code ?? "").trim().toUpperCase();
    if (!rawCode || !CODE_RE.test(rawCode)) {
      throw Errors.badRequest("Invalid promo code format.");
    }

    console.log(`[redeem-promo] ▶ start user=${caller.userId} code="${rawCode}"`);

    // ── Look up the code ─────────────────────────────────────
    const { data: promo, error: fetchErr } = await db
      .from("promo_codes")
      .select("id, code, max_redemptions, times_redeemed, grants_until, is_active")
      .eq("code", rawCode)
      .maybeSingle();

    if (fetchErr) {
      console.error(`[redeem-promo] ✗ DB error during code lookup:`, fetchErr.message);
      throw new AppError("DB_ERROR", "Failed to look up promo code.", 500);
    }
    if (!promo) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=code_not_found`);
      return jsonResponse({ error: "code_not_found", message: "Promo code not found." }, 404);
    }

    console.log(`[redeem-promo]   code found id=${promo.id} active=${promo.is_active} until=${promo.grants_until} used=${promo.times_redeemed}/${promo.max_redemptions ?? '∞'}`);

    if (!promo.is_active) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=code_inactive`);
      return jsonResponse({ error: "code_inactive", message: "This promo code is no longer active." }, 410);
    }
    if (new Date(promo.grants_until) <= new Date()) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=code_expired`);
      return jsonResponse({ error: "code_expired", message: "This promo code has expired." }, 410);
    }
    if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=code_exhausted used=${promo.times_redeemed}/${promo.max_redemptions}`);
      return jsonResponse({ error: "code_exhausted", message: "This promo code has been fully redeemed." }, 410);
    }

    // ── Check for duplicate redemption ───────────────────────
    const { data: existing, error: dupeCheckErr } = await db
      .from("promo_redemptions")
      .select("id")
      .eq("user_id", caller.userId)
      .eq("promo_code_id", promo.id)
      .maybeSingle();

    if (dupeCheckErr) {
      console.error(`[redeem-promo] ✗ DB error during dupe check:`, dupeCheckErr.message);
      throw new AppError("DB_ERROR", "Failed to check redemption status.", 500);
    }

    if (existing) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=already_redeemed`);
      return jsonResponse({ error: "already_redeemed", message: "You've already redeemed this code." }, 409);
    }

    // ── Check if user already has an active real subscription ──
    const { data: profile, error: profileErr } = await db
      .from("profiles")
      .select("subscription_status, subscription_expires_at, promo_until")
      .eq("id", caller.userId)
      .maybeSingle();

    if (profileErr) {
      console.error(`[redeem-promo] ✗ DB error fetching profile:`, profileErr.message);
      throw new AppError("DB_ERROR", "Failed to verify subscription status.", 500);
    }

    const realSubActive =
      profile &&
      ["active", "trial"].includes(profile.subscription_status ?? "") &&
      !profile.promo_until; // exclude promo-granted "active" status

    if (realSubActive) {
      console.warn(`[redeem-promo] ✗ user=${caller.userId} code="${rawCode}" reason=already_pro`);
      return jsonResponse({
        error: "already_pro",
        message: "You already have an active subscription!",
      }, 409);
    }

    // ── Redeem: write redemption record ──────────────────────
    console.log(`[redeem-promo]   inserting redemption record…`);
    const { error: redemptionErr } = await db
      .from("promo_redemptions")
      .insert({ user_id: caller.userId, promo_code_id: promo.id });

    if (redemptionErr) {
      console.error(`[redeem-promo] ✗ DB error inserting redemption:`, redemptionErr.message);
      throw new AppError("DB_ERROR", "Failed to record redemption.", 500);
    }

    // ── Increment usage counter ──────────────────────────────
    console.log(`[redeem-promo]   incrementing usage counter…`);
    const { error: rpcErr } = await db.rpc("increment_promo_redemptions", { promo_id: promo.id });
    if (rpcErr) {
      // Non-fatal: redemption is already recorded; counter can be reconciled.
      console.error(`[redeem-promo] ⚠ RPC increment_promo_redemptions failed (non-fatal):`, rpcErr.message);
    }

    // ── Stamp profile with promo access ──────────────────────
    // Sets the same subscription fields that rc-webhook and list-users
    // already check, PLUS dedicated promo fields so rc-webhook can
    // avoid overwriting promo-granted access.
    console.log(`[redeem-promo]   updating profile with promo access…`);
    const { error: updateErr } = await db
      .from("profiles")
      .update({
        subscription_status:     "active",
        subscription_expires_at: promo.grants_until,
        promo_code_id:           promo.id,
        promo_until:             promo.grants_until,
        updated_at:              new Date().toISOString(),
      })
      .eq("id", caller.userId);

    if (updateErr) {
      console.error(`[redeem-promo] ✗ DB error updating profile:`, updateErr.message);
      throw new AppError("DB_ERROR", "Failed to grant Pro access.", 500);
    }

    console.log(`[redeem-promo] ✓ user=${caller.userId} code="${rawCode}" until=${promo.grants_until}`);

    return jsonResponse({
      ok: true,
      grants_until: promo.grants_until,
      message: `Pro access granted until ${new Date(promo.grants_until).toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })}.`,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
