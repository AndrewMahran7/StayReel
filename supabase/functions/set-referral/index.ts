/// <reference path="../deno-types.d.ts" />
// set-referral/index.ts
//
// POST /set-referral  { code: string }
//
// First-touch ambassador attribution.
// Writes `referred_by` and `referred_at` to the caller's profile
// ONLY if `referred_by` is currently NULL. Returns whether attribution
// succeeded or was already locked.

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

    // ── Parse & validate ─────────────────────────────────────
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

    // ── First-touch: only write if referred_by IS NULL ───────
    const db = adminClient();
    const { data, error } = await db
      .from("profiles")
      .update({
        referred_by: code,
        referred_at: new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq("id", caller.userId)
      .is("referred_by", null)       // first-touch guard
      .select("referred_by")
      .maybeSingle();

    if (error) {
      console.error("[set-referral] DB error:", error.message);
      throw Errors.badRequest("Could not save referral code.");
    }

    // If `data` is null, the WHERE clause didn't match — user already
    // has a referral code assigned (first-touch lock).
    const attributed = data !== null;

    console.log(
      `[set-referral] user=${caller.userId} code=${code} attributed=${attributed}`,
    );

    return jsonResponse({
      attributed,
      referred_by: attributed ? code : undefined,
      message: attributed
        ? "Referral code applied!"
        : "You already have a referral code on file.",
    });
  } catch (err) {
    return errorResponse(err);
  }
});
