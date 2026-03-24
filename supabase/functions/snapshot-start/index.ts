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
import { notifyOwnerOfError }                  from "../_shared/notify.ts";

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

    // ── 3b. Subscription / free-snapshot guard (defense-in-depth) ─
    {
      const { data: prof } = await db
        .from("profiles")
        .select("subscription_status, subscription_expires_at, free_snapshots_used, free_snapshot_limit")
        .eq("id", userId)
        .single();

      if (prof) {
        const subActive = ["active", "trial"].includes(prof.subscription_status ?? "")
          && (!prof.subscription_expires_at || new Date(prof.subscription_expires_at) > new Date());

        if (!subActive) {
          const used  = prof.free_snapshots_used  ?? 0;
          const limit = prof.free_snapshot_limit   ?? 1;
          if (used >= limit) {
            throw Errors.forbidden("Subscription required. Please upgrade to StayReel Pro.");
          }
          // Increment free snapshot usage
          await db
            .from("profiles")
            .update({ free_snapshots_used: used + 1 })
            .eq("id", userId);
        }
      }
    }

    // ── 4a. Clean up stale running jobs ───────────────────────
    // If a job has been "running" without an update for 10+ minutes,
    // the Edge Function that was processing it has long since timed out.
    // Mark it failed so a new job can be created.
    const staleThreshold = new Date(Date.now() - 10 * 60_000).toISOString();
    await db
      .from("snapshot_jobs")
      .update({ status: "failed", error: "Job timed out (stale)", updated_at: new Date().toISOString() })
      .eq("ig_account_id", igAccountId)
      .eq("status", "running")
      .lt("updated_at", staleThreshold);

    // ── 4b. Check for existing running job ────────────────────
    const { data: existingJob } = await db
      .from("snapshot_jobs")
      .select("*")
      .eq("ig_account_id", igAccountId)
      .eq("status", "running")
      .maybeSingle();

    if (existingJob) {
      const j = existingJob as unknown as SnapshotJobRow;
      return jsonResponse({
        jobId:            j.id,
        status:           j.status,
        phase:            j.phase,
        pagesDone:        j.pages_done,
        followersSeen:    (j.followers_json as unknown[]).length,
        followingSeen:    (j.following_json as unknown[]).length,
        followerCountApi: j.follower_count_api,
        followingCountApi:j.following_count_api,
        done:             false,
        message:          "Resuming existing job…",
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

    // ── 7. Check for a cached following list (only refresh once per 24 h) ──
    // If the user has already run a snapshot today, reuse the following list
    // from the most recent complete snapshot. The following phase in the job
    // will detect the pre-filled list and skip the Instagram API fetch.
    const followingWindowStart = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const { data: recentSnap } = await db
      .from("follower_snapshots")
      .select("following_json")
      .eq("ig_account_id", igAccountId)
      .gte("captured_at", followingWindowStart)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const cachedFollowing: unknown[] =
      Array.isArray(recentSnap?.following_json) &&
      (recentSnap.following_json as unknown[]).length > 0
        ? (recentSnap.following_json as unknown[])
        : [];

    // ── 8. Create job row ─────────────────────────────────────
    const { data: jobRow, error: jobErr } = await db
      .from("snapshot_jobs")
      .insert({
        user_id:             userId,
        ig_account_id:       igAccountId,
        source,
        status:              "running",
        phase:               "followers",
        followers_json:      [],
        following_json:      cachedFollowing,   // pre-filled → following phase skipped if non-empty
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

    // ── 9. Run first chunk ────────────────────────────────────
    const result = await runSnapshotChunk(job, cookie, profile.ig_id);

    // ── 10. Audit ─────────────────────────────────────────────
    await writeAuditEvent({
      userId,
      igAccountId,
      eventType: "snapshot_taken",
      payload: { job_id: job.id, phase: result.phase, source },
      ipAddress: extractIp(req),
    }).catch(() => {});

    // Merge followingCached into the response so the app knows from the
    // very first response whether the following list will be served from cache.
    return jsonResponse({ ...result, followingCached: cachedFollowing.length > 0 });

  } catch (err) {
    const code    = err instanceof AppError ? err.code : "INTERNAL_ERROR";
    const message = (err as Error).message ?? "Unknown error";

    await writeAuditEvent({
      userId: userId ?? null,
      igAccountId: igAccountId ?? null,
      eventType: "snapshot_failed",
      payload: { error_code: code, message },
    }).catch(() => {});

    await notifyOwnerOfError({
      source:      "snapshot-start",
      userId,
      igAccountId,
      code,
      message,
      stack: (err as Error).stack ?? null,
    });

    if (igAccountId && err instanceof AppError &&
      (["IG_SESSION_INVALID", "IG_CHALLENGE_REQUIRED", "SESSION_EXPIRED",
        "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED"].includes(err.code))) {
      await adminClient()
        .from("ig_accounts")
        .update({ status: "token_expired", updated_at: new Date().toISOString() })
        .eq("id", igAccountId)
        .then(undefined, () => {});
    }

    // If Instagram explicitly rate-limited this session, extend the cooldown by
    // an extra hour so the user doesn’t immediately retry and get blocked again.
    const isRateLimited = code === "IG_RATE_LIMITED";
    if (igAccountId && isRateLimited) {
      const extendedAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      await adminClient()
        .from("ig_accounts")
        .update({ last_snapshot_at: extendedAt, updated_at: new Date().toISOString() })
        .eq("id", igAccountId)
        .then(undefined, () => {});
    }

    return errorResponse(err);
  }
});
