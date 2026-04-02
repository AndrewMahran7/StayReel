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
import { checkAndEnforce24hLimit, countRunningJobs, MAX_CONCURRENT_JOBS, QUEUED_JOB_TTL_MS } from "../_shared/rate_limit.ts";
import { getIgCurrentUser, assignDeviceProfile, DeviceProfile } from "../_shared/instagram.ts";
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

    // ── 3b. Free-snapshot usage tracking (freemium model) ─────────
    // Snapshots are now unlimited for free users (rate limits still
    // protect the IG account). We just track usage for analytics.
    {
      const { data: prof } = await db
        .from("profiles")
        .select("subscription_status, subscription_expires_at, free_snapshots_used")
        .eq("id", userId)
        .single();

      if (prof) {
        const subActive = ["active", "trial"].includes(prof.subscription_status ?? "")
          && (!prof.subscription_expires_at || new Date(prof.subscription_expires_at) > new Date());

        if (!subActive) {
          const used = prof.free_snapshots_used ?? 0;
          // Track usage (no longer blocks)
          await db
            .from("profiles")
            .update({ free_snapshots_used: used + 1 })
            .eq("id", userId);
        }
      }
    }

    // ── 4. Existing-job check (runs before stale cleanup) ────────────────
    // Return any active job (running OR queued) so the client resumes
    // polling rather than creating a duplicate. Must run FIRST so that
    // jobs with real progress are never accidentally failed below.
    const { data: existingJob } = await db
      .from("snapshot_jobs")
      .select("*")
      .eq("ig_account_id", igAccountId)
      .in("status", ["running", "queued"])
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
        message:          j.status === "queued" ? "Waiting for an available slot…" : "Resuming existing job…",
        resumed:          j.status === "running",
        isFirstSnapshot:  j.is_first_snapshot,
        etaMs:            null,
        followingCached:  (j.following_json as unknown[]).length > 0,
      });
    }

    // ── 4b. Stale-job cleanup (safety net for orphaned rows) ─────────────
    // Only runs when no active job was found above. Two eviction tiers:
    //   • pages_done = 0 AND > 10 min old: stalled before any progress — fail.
    //   • any pages > 0  AND > 2 h old:   truly abandoned — fail.
    // Jobs between these thresholds would have been returned for resumption above.
    const _now = Date.now();
    await db
      .from("snapshot_jobs")
      .update({ status: "failed", error: "Job stalled before making progress", updated_at: new Date(_now).toISOString() })
      .eq("ig_account_id", igAccountId)
      .eq("status", "running")
      .eq("pages_done", 0)
      .lt("updated_at", new Date(_now - 10 * 60_000).toISOString());
    await db
      .from("snapshot_jobs")
      .update({ status: "failed", error: "Job abandoned (no updates for 2 h)", updated_at: new Date(_now).toISOString() })
      .eq("ig_account_id", igAccountId)
      .eq("status", "running")
      .lt("updated_at", new Date(_now - 2 * 60 * 60_000).toISOString());

    // ── 5. Load IG account ────────────────────────────────────
    const { data: igAccount, error: acctErr } = await db
      .from("ig_accounts")
      .select("id, ig_user_id, username, vault_secret_id, status, device_ua, device_id, android_id")
      .eq("id", igAccountId)
      .is("deleted_at", null)
      .single();

    if (acctErr || !igAccount) throw Errors.notFound("IG account");
    const acct = igAccount as unknown as {
      id: string; ig_user_id: string; username: string;
      vault_secret_id: string | null; status: string;
      device_ua: string | null; device_id: string | null; android_id: string | null;
    };
    if (acct.status === "suspended") throw Errors.forbidden();
    if (!acct.vault_secret_id) throw Errors.igSessionInvalid();

    const cookie = await vaultRetrieve(acct.vault_secret_id);

    // ── 5b. Ensure stable device fingerprint ──────────────────
    // Assigned once per IG account and reused forever so Instagram
    // sees a single consistent device identity.
    let deviceProfile: DeviceProfile;
    if (acct.device_ua && acct.device_id && acct.android_id) {
      deviceProfile = { ua: acct.device_ua, deviceId: acct.device_id, androidId: acct.android_id };
    } else {
      deviceProfile = assignDeviceProfile();
      await db.from("ig_accounts").update({
        device_ua:  deviceProfile.ua,
        device_id:  deviceProfile.deviceId,
        android_id: deviceProfile.androidId,
        updated_at: new Date().toISOString(),
      }).eq("id", igAccountId);
    }

    // ── 6. Get profile (resolves ig_user_id + API counts) ─────
    const profile = await getIgCurrentUser(cookie, deviceProfile);
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
    // Detect first-ever snapshot: triggers ultra-safe pacing (lower page cap,
    // longer delays) to make the baseline capture minimally suspicious.
    const { count: priorSnapCount } = await db
      .from("follower_snapshots")
      .select("id", { count: "exact", head: true })
      .eq("ig_account_id", igAccountId);
    const isFirstSnapshot = (priorSnapCount ?? 0) === 0;

    // Enforce global concurrency cap: if too many jobs are already running,
    // insert as "queued" and return immediately — no chunk work yet.
    const runningCount = await countRunningJobs(db);
    const isQueued = runningCount >= MAX_CONCURRENT_JOBS;
    const initialStatus: SnapshotJobRow["status"] = isQueued ? "queued" : "running";

    const { data: jobRow, error: jobErr } = await db
      .from("snapshot_jobs")
      .insert({
        user_id:             userId,
        ig_account_id:       igAccountId,
        source,
        status:              initialStatus,
        phase:               "followers",
        followers_json:      [],
        following_json:      cachedFollowing,   // pre-filled → following phase skipped if non-empty
        follower_count_api:  profile.follower_count,
        following_count_api: profile.following_count,
        post_count_api:      profile.post_count,
        captured_at:         capturedAt,
        pages_done:          0,
        // Safety fields: stable device identity + first-snapshot flag
        device_ua:           deviceProfile.ua,
        device_id:           deviceProfile.deviceId,
        android_id:          deviceProfile.androidId,
        warmup_done:         false,
        is_first_snapshot:   isFirstSnapshot,
        // Telemetry: wall-clock job start time used for ETA estimation
        started_at:          capturedAt,
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

    // ── 9. Queued path: return immediately, no chunk work ─────
    // snapshot-continue will promote this job when a slot opens.
    if (isQueued) {
      return jsonResponse({
        jobId:            job.id,
        status:           "queued",
        phase:            job.phase,
        pagesDone:        0,
        followersSeen:    0,
        followingSeen:    0,
        followerCountApi: job.follower_count_api,
        followingCountApi:job.following_count_api,
        done:             false,
        message:          "Waiting for an available slot…",
        resumed:          false,
        isFirstSnapshot:  isFirstSnapshot,
        etaMs:            null,
        followingCached:  cachedFollowing.length > 0,
      });
    }

    // ── 10. Run first chunk ───────────────────────────────────
    const result = await runSnapshotChunk(job, cookie, profile.ig_id);

    // ── 11. Audit ─────────────────────────────────────────────
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
    // For other IG-related failures extend by 30 min to prevent hammering.
    const IG_COOLDOWN_CODES = new Set([
      "IG_RATE_LIMITED", "IG_SESSION_INVALID", "IG_CHALLENGE_REQUIRED",
      "SESSION_EXPIRED", "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED",
      "SUSPICIOUS_RESPONSE",
    ]);
    if (igAccountId && IG_COOLDOWN_CODES.has(code)) {
      const cooldownMs = code === "IG_RATE_LIMITED"
        ? 60 * 60 * 1_000   // 1 hour for explicit rate-limit
        : 30 * 60 * 1_000;  // 30 min for other IG failures
      const extendedAt = new Date(Date.now() + cooldownMs).toISOString();
      await adminClient()
        .from("ig_accounts")
        .update({ last_snapshot_at: extendedAt, updated_at: new Date().toISOString() })
        .eq("id", igAccountId)
        .then(undefined, () => {});
    }

    return errorResponse(err);
  }
});
