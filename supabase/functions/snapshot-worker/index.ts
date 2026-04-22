/// <reference path="../deno-types.d.ts" />
// snapshot-worker/index.ts
//
// Server-owned chunk executor for the resumable snapshot pipeline.
//
// POST /snapshot-worker  (service-role only)
// Body: { "job_id": "<uuid>" }
//
// Flow:
//   1. Validate service-role caller.
//   2. Load job + acquire lock (claimJobLock).
//   3. Load IG account + cookie from vault.
//   4. Run one chunk via runSnapshotChunk().
//   5. Recompute and persist progress (snapshotProgress).
//   6. Send eligible milestone notifications (snapshotNotifications).
//   7. If incomplete: schedule next_run_at = now and self-trigger (fire-and-forget).
//      If complete:   notification + cleanup already handled by runSnapshotChunk.
//      If failed:     send FAILED or RECONNECT_REQUIRED milestone.
//   8. Always release the lock.
//
// Self-trigger uses fetch() against this same function with the service-role key,
// detached from the response promise so the current invocation returns quickly.
// The fallback scheduler (process-stale-jobs) provides a safety net when the
// self-trigger is dropped (e.g. function cold-start failure).

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { vaultRetrieve }                       from "../_shared/vault.ts";
import {
  runSnapshotChunk,
  claimJobLock,
  releaseJobLock,
  SnapshotJobRow,
} from "../_shared/snapshotJob.ts";
import {
  computeProgress,
  persistProgress,
} from "../_shared/snapshotProgress.ts";
import {
  sendMilestoneNotification,
  milestonesForPercent,
} from "../_shared/snapshotNotifications.ts";
import { notifyOwnerOfError } from "../_shared/notify.ts";

const SELF_TRIGGER_DELAY_MS  = 250;   // micro-delay so the HTTP response can flush first
const MAX_CONSECUTIVE_RETRIES = 6;    // bounded retry guard against runaway self-triggers

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST")    return jsonResponse({ error: "Method not allowed" }, 405);

  // ── Auth: service-role only ──────────────────────────────────────────
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!serviceKey || token !== serviceKey) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let jobId: string;
  try {
    const body = await req.json();
    jobId = String(body?.job_id ?? "").trim();
    if (!jobId) return jsonResponse({ error: "job_id is required" }, 400);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const db = adminClient();
  const workerIdentity = `worker:${crypto.randomUUID().slice(0, 8)}`;
  let acquiredLock = false;

  try {
    // ── Acquire lock ────────────────────────────────────────────────
    const ok = await claimJobLock(db, jobId, workerIdentity);
    if (!ok) {
      console.log(`[snapshot-worker] job=${jobId} lock-busy, skipping`);
      return jsonResponse({ skipped: true, reason: "lock_busy" });
    }
    acquiredLock = true;

    // ── Load job ────────────────────────────────────────────────────
    const { data: jobRow } = await db
      .from("snapshot_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (!jobRow) {
      console.log(`[snapshot-worker] job=${jobId} not found`);
      return jsonResponse({ error: "job not found" }, 404);
    }

    const job = jobRow as unknown as SnapshotJobRow;

    if (job.status === "complete" || job.status === "failed") {
      return jsonResponse({ skipped: true, reason: `terminal:${job.status}` });
    }

    // Promote queued -> running on first worker pickup.
    if (job.status === "queued") {
      const { data: promoted } = await db.from("snapshot_jobs")
        .update({ status: "running", updated_at: new Date().toISOString() })
        .eq("id", jobId)
        .eq("status", "queued")
        .select("id")
        .maybeSingle();
      if (!promoted) {
        return jsonResponse({ skipped: true, reason: "promotion_failed" });
      }
      job.status = "running";
    }

    // ── Bounded retry guard ─────────────────────────────────────────
    if ((job.consecutive_retry_count ?? 0) >= MAX_CONSECUTIVE_RETRIES) {
      const failedAt = new Date().toISOString();
      await db.from("snapshot_jobs").update({
        status:           "failed",
        error:            "Exceeded maximum consecutive retries.",
        failure_code:     "MAX_RETRIES_EXCEEDED",
        progress_stage:   "failed",
        completed_at:     failedAt,
        updated_at:       failedAt,
      }).eq("id", jobId);
      await sendMilestoneNotification(db, jobId, job.user_id, job.ig_account_id, "FAILED");
      return jsonResponse({ failed: true, reason: "max_retries" });
    }

    // ── Load IG account + cookie ───────────────────────────────────
    const { data: igAccount } = await db
      .from("ig_accounts")
      .select("ig_user_id, vault_secret_id, status, reconnect_required")
      .eq("id", job.ig_account_id)
      .is("deleted_at", null)
      .single();

    if (!igAccount || igAccount.status === "suspended" || !igAccount.vault_secret_id) {
      await failJob(db, jobId, job, "Account unavailable.", "ACCOUNT_UNAVAILABLE");
      await sendMilestoneNotification(db, jobId, job.user_id, job.ig_account_id, "FAILED");
      return jsonResponse({ failed: true, reason: "account_unavailable" });
    }
    if (igAccount.reconnect_required) {
      await failJob(db, jobId, job, "Reconnect Instagram to continue tracking.", "RECONNECT_REQUIRED");
      await sendMilestoneNotification(db, jobId, job.user_id, job.ig_account_id, "RECONNECT_REQUIRED");
      return jsonResponse({ failed: true, reason: "reconnect_required" });
    }

    const cookie = await vaultRetrieve(igAccount.vault_secret_id);

    // ── Mark chunk start ────────────────────────────────────────────
    const chunkStartedAt = new Date().toISOString();
    await db.from("snapshot_jobs").update({
      last_chunk_started_at: chunkStartedAt,
      worker_attempt_count:  (job.worker_attempt_count ?? 0) + 1,
      updated_at:            chunkStartedAt,
    }).eq("id", jobId);

    // ── Run one chunk of work ──────────────────────────────────────
    let result;
    try {
      result = await runSnapshotChunk(job, cookie, igAccount.ig_user_id);
    } catch (chunkErr) {
      const msg = (chunkErr as Error).message ?? "Unknown chunk error";
      console.error(`[snapshot-worker] job=${jobId} chunk error:`, msg);
      // Increment retry counter and schedule a backoff.
      const nextRetry = (job.consecutive_retry_count ?? 0) + 1;
      const backoffMs = Math.min(5_000 * Math.pow(2, nextRetry), 5 * 60_000);
      const nextRunAt = new Date(Date.now() + backoffMs).toISOString();
      await db.from("snapshot_jobs").update({
        consecutive_retry_count: nextRetry,
        next_run_at:             nextRunAt,
        updated_at:              new Date().toISOString(),
      }).eq("id", jobId);
      await notifyOwnerOfError({
        source: "snapshot-worker", userId: job.user_id, igAccountId: job.ig_account_id,
        jobId, code: "CHUNK_ERROR", message: msg,
      });
      return jsonResponse({ retrying: true, next_run_at: nextRunAt });
    }

    // ── Persist progress ───────────────────────────────────────────
    const phase = (result.phase as "followers" | "following" | "finalize");
    const progress = computeProgress(job, {
      phase,
      followersDone: result.followersSeen,
      followingDone: result.followingSeen,
      terminal: result.status === "complete" ? "complete"
              : result.status === "failed"   ? (isReconnectMessage(result.message) ? "reconnect_required" : "failed")
              : undefined,
    });
    await persistProgress(db, jobId, progress);

    // ── Milestone notifications ────────────────────────────────────
    if (result.status === "complete") {
      // The finalize block in runSnapshotChunk already sent the personalised
      // "Snapshot Ready" push (only when it was the request that flipped status
      // → complete). We still mark COMPLETE in the bitmask so the fallback
      // scheduler doesn't double-send.
      await sendMilestoneNotification(
        db, jobId, job.user_id, job.ig_account_id, "COMPLETE",
        "Your latest snapshot is ready. Tap to see your results.",
      );
    } else if (result.status === "failed") {
      const milestone = isReconnectMessage(result.message) ? "RECONNECT_REQUIRED" : "FAILED";
      await sendMilestoneNotification(db, jobId, job.user_id, job.ig_account_id, milestone);
    } else {
      // Progress milestones — claim each in order; idempotent.
      for (const m of milestonesForPercent(progress.percent)) {
        await sendMilestoneNotification(db, jobId, job.user_id, job.ig_account_id, m);
      }
    }

    // ── Continuation ───────────────────────────────────────────────
    if (result.status === "running") {
      // Reset consecutive retry on successful chunk.
      const nextRunAt = new Date(Date.now() + SELF_TRIGGER_DELAY_MS).toISOString();
      await db.from("snapshot_jobs").update({
        next_run_at:             nextRunAt,
        consecutive_retry_count: 0,
        updated_at:              new Date().toISOString(),
      }).eq("id", jobId);

      // Release the lock BEFORE self-trigger so the next invocation can claim it.
      await releaseJobLock(db, jobId, workerIdentity).catch(() => {});
      acquiredLock = false;

      // Fire-and-forget self-trigger. The fallback scheduler will pick up the
      // job within ~2 minutes if this trigger is dropped.
      void selfTrigger(jobId, serviceKey);

      return jsonResponse({
        running: true,
        progress_percent: progress.percent,
        progress_stage:   progress.stage,
        next_run_at:      nextRunAt,
      });
    }

    // Terminal: clear next_run_at so the scheduler ignores this row.
    await db.from("snapshot_jobs").update({
      next_run_at: null,
      updated_at:  new Date().toISOString(),
    }).eq("id", jobId);

    return jsonResponse({
      done: true,
      status: result.status,
      progress_percent: progress.percent,
      progress_stage:   progress.stage,
    });

  } catch (err) {
    const msg = (err as Error).message ?? "Unknown error";
    console.error(`[snapshot-worker] job=${jobId} top-level error:`, msg);
    await notifyOwnerOfError({
      source: "snapshot-worker", jobId, code: "WORKER_ERROR", message: msg,
    });
    return jsonResponse({ error: msg }, 500);
  } finally {
    if (acquiredLock) {
      await releaseJobLock(db, jobId, workerIdentity).catch(() => {});
    }
  }
});

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Fire-and-forget self-trigger. Detaches the fetch promise so the current
 * invocation can return without waiting for the next one.
 */
function selfTrigger(jobId: string, serviceKey: string): void {
  const url = (Deno.env.get("SUPABASE_URL") ?? "") + "/functions/v1/snapshot-worker";
  if (!url) return;
  // Intentionally not awaited.
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ job_id: jobId }),
  }).catch((err) => {
    console.warn(`[snapshot-worker] self-trigger fetch failed for job=${jobId}:`, (err as Error).message);
  });
}

function isReconnectMessage(msg: string | undefined): boolean {
  if (!msg) return false;
  const m = msg.toUpperCase();
  return m.includes("RECONNECT")
      || m.includes("SESSION_EXPIRED")
      || m.includes("CHALLENGE_REQUIRED")
      || m.includes("CHECKPOINT_REQUIRED")
      || m.includes("IG_SESSION_INVALID");
}

// deno-lint-ignore no-explicit-any
async function failJob(db: any, jobId: string, job: SnapshotJobRow, message: string, code: string): Promise<void> {
  const failedAt = new Date().toISOString();
  const totalDurationMs = job.started_at
    ? Date.now() - new Date(job.started_at).getTime()
    : null;
  await db.from("snapshot_jobs").update({
    status:            "failed",
    error:             message,
    failure_code:      code,
    progress_stage:    code === "RECONNECT_REQUIRED" ? "reconnect_required" : "failed",
    completed_at:      failedAt,
    total_duration_ms: totalDurationMs,
    next_run_at:       null,
    updated_at:        failedAt,
  }).eq("id", jobId);
}
