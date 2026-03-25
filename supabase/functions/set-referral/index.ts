/// <reference path="../deno-types.d.ts" />
// set-referral/index.ts
//
// POST /set-referral  { code: string }
//
// First-touch ambassador attribution with code validation.
//
// Flow:
// 1. Parse & normalise the code (lowercase, trim).
// 2. Validate the code exists in `ambassadors` AND is_active = true.
// 3. Check that the caller does NOT already have a referred_by value.
// 4. Atomically set referred_by + referred_at on the caller's profile.
//
// Error codes returned in the JSON body (`error` field) so the client
// can show contextual messages:
//   "code_not_found"     – code does not exist in ambassadors table
//   "code_unavailable"   – code found but is_active = false
//   "already_attributed" – user already has a referral code on file
//   "bad_request"        – malformed input

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors }               from "../_shared/errors.ts";
import { requireAuth }                         from "../_shared/auth.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";

/** Alphanumeric + underscores/hyphens, 3-30 chars. */
const CODE_RE = /^[a-z0-9_-]{3,30}$/;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    const caller = await requireAuth(req);

    // ── Parse & validate input ───────────────────────────────
    let body: { code?: string };
    try {
      body = await req.json();
    } catch {
      throw Errors.badRequest("Invalid JSON body.");
    }

    const code = (body.code ?? "").trim().toLowerCase();

    if (!code) {
      throw Errors.badRequest("code is required.");
    }
    if (!CODE_RE.test(code)) {
      throw Errors.badRequest(
        "Invalid code format. Use 3-30 alphanumeric characters, hyphens, or underscores.",
      );
    }

    const db = adminClient();

    // ── Step 1: Validate code against ambassadors table ──────
    const { data: ambassador, error: ambErr } = await db
      .from("ambassadors")
      .select("code, is_active")
      .eq("code", code)
      .maybeSingle();

    if (ambErr) {
      console.error("[set-referral] ambassadors lookup error:", ambErr.message);
      return jsonResponse(
        { success: false, error: "server_error", message: "Could not validate referral code. Try again later." },
        200,
      );
    }

    if (!ambassador) {
      console.log(`[set-referral] code_not_found user=${caller.userId} code=${code}`);
      return jsonResponse(
        { success: false, error: "code_not_found" },
        200,
      );
    }

    if (!ambassador.is_active) {
      console.log(`[set-referral] code_unavailable user=${caller.userId} code=${code}`);
      return jsonResponse(
        { success: false, error: "code_unavailable" },
        200,
      );
    }

    // ── Step 2: Check if user is already attributed ──────────
    const { data: profile, error: profileErr } = await db
      .from("profiles")
      .select("referred_by")
      .eq("id", caller.userId)
      .maybeSingle();

    if (profileErr) {
      console.error("[set-referral] profile lookup error:", profileErr.message);
      return jsonResponse(
        { success: false, error: "server_error", message: "Could not read profile. Try again later." },
        200,
      );
    }

    if (profile?.referred_by) {
      console.log(
        `[set-referral] already attributed user=${caller.userId} existing=${profile.referred_by}`,
      );
      return jsonResponse(
        { success: false, error: "already_attributed", message: "You already have a referral code on file." },
        200,
      );
    }

    // ── Step 3: Atomic first-touch write ─────────────────────
    // The IS NULL guard on referred_by prevents any race condition
    // where two concurrent requests could both pass Step 2.
    const { data: updated, error: updateErr } = await db
      .from("profiles")
      .update({
        referred_by: code,
        referred_at: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq("id", caller.userId)
      .is("referred_by", null)        // atomic first-touch guard
      .select("referred_by")
      .maybeSingle();

    if (updateErr) {
      console.error("[set-referral] update error:", updateErr.message);
      return jsonResponse(
        { success: false, error: "server_error", message: "Could not save referral code. Try again later." },
        200,
      );
    }

    // If `updated` is null the IS NULL guard fired — concurrent request
    // already wrote a code between Step 2 and Step 3.
    if (!updated) {
      console.log(
        `[set-referral] race: already attributed user=${caller.userId} code=${code}`,
      );
      return jsonResponse(
        { success: false, error: "already_attributed", message: "You already have a referral code on file." },
        200,
      );
    }

    console.log(
      `[set-referral] success user=${caller.userId} code=${code}`,
    );

    return jsonResponse({
      success: true,
      referred_by: code,
      message: "Referral code applied!",
    });
  } catch (err) {
    return errorResponse(err);
  }
});
