/// <reference path="../deno-types.d.ts" />
// snapshot-start/index.ts
//
// POST /snapshot-start
// Body: { "ig_account_id": "<uuid>", "source": "manual" | "cron" | "onboarding" }
//
// 1. Auth + ownership check.
// 2. 24h rate-limit guard (manual only).
// 3. If a running job already exists for this account, return it
//    (app resumes polling without creating a duplicate).
// 4. Get IG profile info (ig_user_id, API counts, captured_at).
// 5. Create snapshot_jobs row.
// 6. Run the first follower chunk.
// 7. Return { jobId, status, phase, pagesDone, followersSeen, followingSeen, done }.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors, AppError }     from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount }     from "../_shared/auth.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { checkAndEnforce24hLimit }             from "../_shared/rate_limit.ts";
import { getIgCurrentUser }                    from "../_shared/instagram.ts";
import { vaultRetrieve }                       from "../_shared/vault.ts";
import { writeAuditEvent, extractIp }          from "../_shared/audit.ts";
import { runSnapshotChunk, SnapshotJobRow }    from "../_shared/snapshotJob.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let userId: string | undefined;
  let igAccountId: string | undefined;

  try {
    // ── 1. Auth ──────────────────────────────────────────────
    const caller = await requireAuth(req);
    userId = caller.userId;

    // ── 2. Parse body ─────────────────────────────────────────
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { throw Errors.badRequest("Request body must be valid JSON."); }

    igAccountId = String(body?.ig_account_id ?? "").trim();
    const source = String(body?.source ?? "manual");

    if (!igAccountId) throw Errors.badRequest("ig_account_id is required.");
    if (!["manual", "cron", "onboarding"].includes(source)) {
      throw Errors.badRequest("source must be manual | cron | onboarding");
    }

    await requireOwnsAccount(caller.authHeader, igAccountId);

    // ── 3. Rate-limit guard ───────────────────────────────────
    if (source === "manual") {
      await checkAndEnforce24hLimit(userId, igAccountId);
    }

    const db = adminClient();

    // ── 4. Check for existing running job ─────────────────────
    const { data: existingJob } = await db
      .from("snapshot_jobs")
      .select("*")
      .eq("ig_account_id", igAccountId)
      .eq("status", "running")
      .maybeSingle();

    if (existingJob) {
      const j = existingJob as unknown as SnapshotJobRow;
      return jsonResponse({
        jobId:         j.id,
        status:        j.status,
        phase:         j.phase,
        pagesDone:     j.pages_done,
        followersSeen: (j.followers_json as unknown[]).length,
        followingSeen: (j.following_json as unknown[]).length,
        done:          false,
        message:       "Resuming existing job…",
      });
    }

    // ── 5. Load IG account ────────────────────────────────────
    const { data: igAccount, error: acctErr } = await db
      .from("ig_accounts")
      .select("id, ig_user_id, username, vault_secret_id, status")
      .eq("id", igAccountId)
      .is("deleted_at", null)
      .single();

    if (acctErr || !igAccount) throw Errors.notFound("IG account");
    const acct = igAccount as unknown as {
      id: string; ig_user_id: string; username: string;
      vault_secret_id: string | null; status: string;
    };
    if (acct.status === "suspended") throw Errors.forbidden();
    if (!acct.vault_secret_id) throw Errors.igSessionInvalid();

    const cookie = await vaultRetrieve(acct.vault_secret_id);

    // ── 6. Get profile (resolves ig_user_id + API counts) ─────
    const profile = await getIgCurrentUser(cookie);
    const capturedAt = new Date().toISOString();

    // ── 7. Create job row ─────────────────────────────────────
    const { data: jobRow, error: jobErr } = await db
      .from("snapshot_jobs")
      .insert({
        user_id:             userId,
        ig_account_id:       igAccountId,
        source,
        status:              "running",
        phase:               "followers",
        followers_json:      [],
        following_json:      [],
        follower_count_api:  profile.follower_count,
        following_count_api: profile.following_count,
        post_count_api:      profile.post_count,
        captured_at:         capturedAt,
        pages_done:          0,
      })
      .select("*")
      .single();

    if (jobErr || !jobRow) {
      // Unique constraint violation = another job started concurrently
      if (jobErr?.code === "23505") {
        throw Errors.badRequest("A snapshot job is already running for this account.");
      }
      throw Errors.internal(`Job create failed: ${jobErr?.message}`);
    }

    const job = jobRow as unknown as SnapshotJobRow;

    // ── 8. Run first chunk ────────────────────────────────────
    const result = await runSnapshotChunk(job, cookie, profile.ig_id);

    // ── 9. Audit ──────────────────────────────────────────────
    await writeAuditEvent({
      userId,
      igAccountId,
      eventType: "snapshot_taken",
      payload: { job_id: job.id, phase: result.phase, source },
      ipAddress: extractIp(req),
    }).catch(() => {});

    return jsonResponse(result);

  } catch (err) {
    await writeAuditEvent({
      userId: userId ?? null,
      igAccountId: igAccountId ?? null,
      eventType: "snapshot_failed",
      payload: { error_code: (err instanceof AppError ? err.code : "UNKNOWN"), message: String((err as Error).message) },
    }).catch(() => {});

    if (igAccountId && err instanceof AppError &&
      (err.code === "IG_SESSION_INVALID" || err.code === "IG_CHALLENGE_REQUIRED")) {
      await adminClient()
        .from("ig_accounts")
        .update({ status: "token_expired", updated_at: new Date().toISOString() })
        .eq("id", igAccountId)
        .then(undefined, () => {});
    }

    return errorResponse(err);
  }
});
