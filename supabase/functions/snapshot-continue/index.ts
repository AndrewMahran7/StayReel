/// <reference path="../deno-types.d.ts" />
// snapshot-continue/index.ts
//
// POST /snapshot-continue
// Body: { "job_id": "<uuid>" }
//
// Called by the app every ~1 s while done === false.
// 1. Auth check.
// 2. Load job, verify ownership.
// 3. If job is already complete/failed return current state (done=true).
// 4. Load IG account cookie from vault.
// 5. Run next chunk via runSnapshotChunk.
// 6. Return { jobId, status, phase, pagesDone, followersSeen, followingSeen, done }.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors }               from "../_shared/errors.ts";
import { requireAuth }                          from "../_shared/auth.ts";
import { adminClient }                          from "../_shared/supabase_client.ts";
import { vaultRetrieve }                        from "../_shared/vault.ts";
import { runSnapshotChunk, SnapshotJobRow, claimJobLock, releaseJobLock, updateHeartbeat } from "../_shared/snapshotJob.ts";
import { notifyOwnerOfError }                  from "../_shared/notify.ts";
import { countRunningJobs, MAX_CONCURRENT_JOBS, tryPromoteQueuedJob } from "../_shared/rate_limit.ts";
import { classifyFetchFailure, requiresReconnect as isReconnectCategory } from "../_shared/instagram.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    // ── 1. Auth ──────────────────────────────────────────────
    const caller = await requireAuth(req);

    // ── 2. Parse body ─────────────────────────────────────────
    let body: Record<string, unknown>;
    try { body = await req.json(); }
    catch { throw Errors.badRequest("Request body must be valid JSON."); }

    const jobId = String(body?.job_id ?? "").trim();
    if (!jobId) throw Errors.badRequest("job_id is required.");

    const db = adminClient();

    // ── 3. Load job ───────────────────────────────────────────
    const { data: jobRow, error: jobErr } = await db
      .from("snapshot_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (jobErr || !jobRow) throw Errors.notFound("Snapshot job");

    const job = jobRow as unknown as SnapshotJobRow;

    // ── 4. Ownership check ────────────────────────────────────
    if (job.user_id !== caller.userId) throw Errors.forbidden();

    // ── 5. Already terminal? ──────────────────────────────────
    if (job.status === "complete" || job.status === "failed") {
      return jsonResponse({
        jobId:            job.id,
        status:           job.status,
        phase:            job.phase,
        pagesDone:        job.pages_done,
        followersSeen:    (job.followers_json as unknown[]).length,
        followingSeen:    (job.following_json as unknown[]).length,
        followerCountApi: job.follower_count_api,
        followingCountApi:job.following_count_api,
        done:             true,
        error:            job.error ?? undefined,
      });
    }

    // ── 5b. Queued promotion ────────────────────────────────
    // When a job is queued, check if a slot has opened up. If so,
    // atomically promote it to 'running' and fall through to run a chunk.
    // If the slot is still full, return the queued status to the client.
    if (job.status === "queued") {
      const runningCount = await countRunningJobs(db);
      if (runningCount >= MAX_CONCURRENT_JOBS) {
        return jsonResponse({
          jobId:            job.id,
          status:           "queued",
          phase:            job.phase,
          pagesDone:        job.pages_done,
          followersSeen:    (job.followers_json as unknown[]).length,
          followingSeen:    (job.following_json as unknown[]).length,
          followerCountApi: job.follower_count_api,
          followingCountApi:job.following_count_api,
          done:             false,
          message:          "Waiting for an available slot\u2026",
          etaMs:            null,
          isFirstSnapshot:  job.is_first_snapshot,
        });
      }
      const promoted = await tryPromoteQueuedJob(db, job.id);
      if (!promoted) {
        // Another concurrent poll already promoted this job; wait one cycle.
        return jsonResponse({
          jobId:   job.id,
          status:  "queued",
          phase:   job.phase,
          pagesDone: job.pages_done,
          done:    false,
          message: "Starting\u2026",
          etaMs:   null,
          isFirstSnapshot: job.is_first_snapshot,
        });
      }
      // Promotion succeeded — refresh the local job object to status=running.
      (job as any).status = "running";
    }

    // ── 6. Load IG account + cookie ───────────────────────────────
    const { data: igAccount, error: acctErr } = await db
      .from("ig_accounts")
      .select("id, ig_user_id, vault_secret_id, status, reconnect_required")
      .eq("id", job.ig_account_id)
      .is("deleted_at", null)
      .single();

    if (acctErr || !igAccount) throw Errors.notFound("IG account");
    const acct = igAccount as unknown as {
      id: string; ig_user_id: string;
      vault_secret_id: string | null; status: string;
      reconnect_required: boolean;
    };
    if (acct.status === "suspended") throw Errors.forbidden();

    // ── 6b. Block if reconnect required ──────────────────────────
    if (acct.reconnect_required) {
      console.log(`[snapshot-continue] Job ${job.id} blocked: account ${acct.id} requires reconnect`);
      // Silently end the job — user sees tracking-paused state, not an error
      await db.from("snapshot_jobs").update({
        status: "failed",
        error: "Tracking paused — reconnect Instagram to resume",
        failure_code: "RECONNECT_REQUIRED",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", job.id).eq("status", "running");
      return jsonResponse({
        jobId: job.id, status: "failed", phase: job.phase,
        pagesDone: job.pages_done,
        followersSeen: (job.followers_json as unknown[]).length,
        followingSeen: (job.following_json as unknown[]).length,
        done: true,
        reconnect_required: true,
        tracking_state: "tracking_paused_reconnect_required",
        message: "Tracking is paused until you reconnect Instagram.",
      });
    }

    if (!acct.vault_secret_id) throw Errors.igSessionInvalid();

    const cookie = await vaultRetrieve(acct.vault_secret_id);
    const igUserId = acct.ig_user_id;

    // ── 7. Acquire lock + heartbeat ──────────────────────────────
    // Update the heartbeat on every poll to prove the client is alive.
    // The stale-job worker uses last_heartbeat_at to decide whether to
    // take over a job.
    await updateHeartbeat(db, job.id);

    const lockAcquired = await claimJobLock(db, job.id, "client");
    if (!lockAcquired) {
      // Another processor (stale-job worker) is currently running a
      // chunk for this job. The heartbeat update above is enough to
      // signal the client is still alive. Return current state and
      // let the poll loop retry on the next cycle.
      console.log(`[snapshot-continue] Job ${job.id} locked by another processor, skipping chunk.`);
      return jsonResponse({
        jobId:            job.id,
        status:           job.status,
        phase:            job.phase,
        pagesDone:        job.pages_done,
        followersSeen:    (job.followers_json as unknown[]).length,
        followingSeen:    (job.following_json as unknown[]).length,
        followerCountApi: job.follower_count_api,
        followingCountApi:job.following_count_api,
        done:             false,
        message:          "Processing\u2026",
        etaMs:            null,
        isFirstSnapshot:  job.is_first_snapshot,
      });
    }

    // ── 8. Run next chunk ─────────────────────────────────────
    let result;
    try {
      result = await runSnapshotChunk(job, cookie, igUserId);
    } finally {
      // Always release the lock after chunk processing, whether it
      // succeeded or failed. The next poll will re-acquire it.
      await releaseJobLock(db, job.id, "client").catch(() => {});
    }

    // ── Post-chunk failure handling ────────────────────────────────
    // snapshotJob.ts now handles reconnect marking and progress
    // persistence internally. We only need to extend cooldowns here
    // for non-auth IG failures.
    if (result.status === 'failed' && result.message) {
      const IG_FAILURE_PATTERNS = ["IG_RATE_LIMITED", "SESSION_EXPIRED", "CHALLENGE_REQUIRED",
        "CHECKPOINT_REQUIRED", "SUSPICIOUS_RESPONSE", "IG_SESSION_INVALID"];
      if (IG_FAILURE_PATTERNS.some(p => result.message!.includes(p))) {
        const isRateLimit = result.message.includes("IG_RATE_LIMITED");
        const cooldownMs = isRateLimit ? 60 * 60 * 1_000 : 30 * 60 * 1_000;
        const extendedAt = new Date(Date.now() + cooldownMs).toISOString();
        await db
          .from("ig_accounts")
          .update({ last_snapshot_at: extendedAt, updated_at: new Date().toISOString() })
          .eq("id", job.ig_account_id)
          .then(undefined, () => {});
      }
    }

    // Notify owner if the job failed for a non-trivial reason
    if (result.status === 'failed') {
      await notifyOwnerOfError({
        source:      "snapshot-continue",
        userId:      caller.userId,
        igAccountId: job.ig_account_id,
        jobId:       job.id,
        code:        result.message ?? "UNKNOWN",
        message:     result.message ?? "Job failed during chunk processing",
      });
    }

    return jsonResponse(result);

  } catch (err) {
    await notifyOwnerOfError({
      source:  "snapshot-continue",
      userId:  (err as { userId?: string }).userId ?? null,
      code:    (err as { code?: string }).code ?? "INTERNAL_ERROR",
      message: (err as Error).message ?? "Unknown error",
      stack:   (err as Error).stack ?? null,
    });
    return errorResponse(err);
  }
});
