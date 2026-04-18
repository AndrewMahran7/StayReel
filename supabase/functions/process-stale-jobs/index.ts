/// <reference path="../deno-types.d.ts" />
// process-stale-jobs/index.ts
//
// POST /process-stale-jobs
//
// Server-side background processor for snapshot jobs that no longer have
// an active client polling.  Intended to be called by pg_cron (via pg_net)
// every 2 minutes.
//
// Flow:
//   1. Find running jobs with updated_at older than 90 s (no client polling).
//   2. Atomically claim each job (optimistic lock on updated_at).
//   3. Load IG account cookie from vault.
//   4. Run one chunk via runSnapshotChunk.
//   5. Process up to 3 jobs per invocation to stay within edge-function limits.
//
// Security: requires service-role Bearer token (pg_cron uses pg_net with
// the service role key).

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { vaultRetrieve }                       from "../_shared/vault.ts";
import { runSnapshotChunk, SnapshotJobRow, claimJobLock, releaseJobLock } from "../_shared/snapshotJob.ts";
import { notifyOwnerOfError }                  from "../_shared/notify.ts";

const MAX_JOBS_PER_RUN   = 3;
const STALE_THRESHOLD_MS = 120_000; // 120 seconds without a heartbeat

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // ── Security: only service-role callers (pg_cron / admin) ──────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!serviceRoleKey || token !== serviceRoleKey) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const db = adminClient();
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS).toISOString();
  const processed: string[] = [];
  const errors: string[] = [];

  try {
    // ── Find stale running jobs by heartbeat (oldest first, limited) ────
    // A job is considered stale when its last_heartbeat_at is older than
    // the threshold, meaning no client has polled recently AND no worker
    // is actively processing it. Falls back to updated_at for jobs
    // created before 025_snapshot_job_locking (legacy backcompat).
    const { data: staleJobs, error: queryErr } = await db
      .from("snapshot_jobs")
      .select("id, ig_account_id, user_id, last_heartbeat_at, updated_at")
      .eq("status", "running")
      .or(`last_heartbeat_at.lt.${cutoff},and(last_heartbeat_at.is.null,updated_at.lt.${cutoff})`)
      .order("updated_at", { ascending: true })
      .limit(MAX_JOBS_PER_RUN);

    if (queryErr || !staleJobs || staleJobs.length === 0) {
      return jsonResponse({ message: "No stale jobs found.", processed: 0 });
    }

    console.log(`[process-stale-jobs] Found ${staleJobs.length} stale job(s).`);

    for (const staleJob of staleJobs) {
      try {
        // ── Acquire the processing lock via claimJobLock ────────────
        // If the client has resumed polling (heartbeat updated), or
        // another worker already holds the lock, this will return false.
        const workerIdentity = `worker:${crypto.randomUUID().slice(0, 8)}`;
        const lockAcquired = await claimJobLock(db, staleJob.id, workerIdentity);

        if (!lockAcquired) {
          console.log(`[process-stale-jobs] Job ${staleJob.id} locked by another processor or client resumed.`);
          continue;
        }

        // Re-fetch the full job row now that we hold the lock.
        const { data: claimed } = await db
          .from("snapshot_jobs")
          .select("*")
          .eq("id", staleJob.id)
          .eq("status", "running")
          .maybeSingle();

        if (!claimed) {
          await releaseJobLock(db, staleJob.id, workerIdentity).catch(() => {});
          console.log(`[process-stale-jobs] Job ${staleJob.id} no longer running after lock acquired.`);
          continue;
        }

        const job = claimed as unknown as SnapshotJobRow;

        // ── Load IG account + cookie ─────────────────────────────────
        const { data: igAccount } = await db
          .from("ig_accounts")
          .select("ig_user_id, vault_secret_id, status, reconnect_required")
          .eq("id", job.ig_account_id)
          .is("deleted_at", null)
          .single();

        if (!igAccount || igAccount.status === "suspended" || !igAccount.vault_secret_id || igAccount.reconnect_required) {
          // Account disconnected or suspended while job was in progress
          const failedAt = new Date().toISOString();
          const totalDurationMs = job.started_at
            ? Date.now() - new Date(job.started_at).getTime()
            : null;
          await db.from("snapshot_jobs").update({
            status:            "failed",
            error:             "IG account disconnected or suspended while job was in progress.",
            failure_code:      "ACCOUNT_DISCONNECTED",
            completed_at:      failedAt,
            total_duration_ms: totalDurationMs,
            updated_at:        failedAt,
            locked_by:         null,
            lock_acquired_at:  null,
          }).eq("id", job.id);
          console.log(`[process-stale-jobs] Job ${job.id} failed: account unavailable.`);
          errors.push(job.id);
          continue;
        }

        const cookie = await vaultRetrieve(igAccount.vault_secret_id);

        // ── Run one chunk of work ────────────────────────────────────
        console.log(`[process-stale-jobs] Processing job ${job.id} (phase: ${job.phase}, pages: ${job.pages_done})`);
        let result;
        try {
          result = await runSnapshotChunk(job, cookie, igAccount.ig_user_id);
        } finally {
          // Always release the lock after processing, even on error.
          await releaseJobLock(db, job.id, workerIdentity).catch(() => {});
        }
        processed.push(job.id);
        console.log(`[process-stale-jobs] Job ${job.id} → ${result.status} (done: ${result.done})`);

        // ── Handle IG failures with cooldown + account status updates ──
        if (result.status === "failed" && result.message) {
          const IG_FAILURE_PATTERNS = [
            "IG_RATE_LIMITED", "SESSION_EXPIRED", "CHALLENGE_REQUIRED",
            "CHECKPOINT_REQUIRED", "SUSPICIOUS_RESPONSE", "IG_SESSION_INVALID",
          ];
          if (IG_FAILURE_PATTERNS.some((p) => result.message.includes(p))) {
            // Mark IG account as token_expired for session/challenge failures
            const sessionFailures = ["SESSION_EXPIRED", "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED"];
            if (sessionFailures.some((p) => result.message.includes(p))) {
              await db.from("ig_accounts").update({
                status:     "token_expired",
                updated_at: new Date().toISOString(),
              }).eq("id", job.ig_account_id).then(undefined, () => {});
            }

            // Extend cooldown to prevent immediate retry
            const isRateLimit = result.message.includes("IG_RATE_LIMITED");
            const cooldownMs  = isRateLimit ? 60 * 60 * 1_000 : 30 * 60 * 1_000;
            const extendedAt  = new Date(Date.now() + cooldownMs).toISOString();
            await db.from("ig_accounts").update({
              last_snapshot_at: extendedAt,
              updated_at:       new Date().toISOString(),
            }).eq("id", job.ig_account_id).then(undefined, () => {});
          }

          await notifyOwnerOfError({
            source:      "process-stale-jobs",
            userId:      job.user_id,
            igAccountId: job.ig_account_id,
            jobId:       job.id,
            code:        result.message,
            message:     `Stale job failed: ${result.message}`,
          });
        }

      } catch (jobErr) {
        console.error(`[process-stale-jobs] Error processing job ${staleJob.id}:`, (jobErr as Error).message);
        errors.push(staleJob.id);
      }
    }

  } catch (err) {
    console.error("[process-stale-jobs] Top-level error:", (err as Error).message);
    return jsonResponse({ error: (err as Error).message }, 500);
  }

  return jsonResponse({
    message:     `Processed ${processed.length} stale job(s).`,
    processed:   processed.length,
    errors:      errors.length,
    jobIds:      processed,
    errorJobIds: errors,
  });
});
