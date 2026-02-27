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
import { runSnapshotChunk, SnapshotJobRow }     from "../_shared/snapshotJob.ts";
import { notifyOwnerOfError }                  from "../_shared/notify.ts";

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
        jobId:         job.id,
        status:        job.status,
        phase:         job.phase,
        pagesDone:     job.pages_done,
        followersSeen: (job.followers_json as unknown[]).length,
        followingSeen: (job.following_json as unknown[]).length,
        done:          true,
        error:         job.error ?? undefined,
      });
    }

    // ── 6. Load IG account + cookie ───────────────────────────
    const { data: igAccount, error: acctErr } = await db
      .from("ig_accounts")
      .select("id, ig_user_id, vault_secret_id, status")
      .eq("id", job.ig_account_id)
      .is("deleted_at", null)
      .single();

    if (acctErr || !igAccount) throw Errors.notFound("IG account");
    const acct = igAccount as unknown as {
      id: string; ig_user_id: string;
      vault_secret_id: string | null; status: string;
    };
    if (acct.status === "suspended") throw Errors.forbidden();
    if (!acct.vault_secret_id) throw Errors.igSessionInvalid();

    const cookie = await vaultRetrieve(acct.vault_secret_id);
    const igUserId = acct.ig_user_id;

    // ── 7. Run next chunk ─────────────────────────────────────
    const result = await runSnapshotChunk(job, cookie, igUserId);

    // Mark IG account suspended if session died mid-job
    if (result.status === 'failed' && result.message &&
      (result.message.includes("SESSION_EXPIRED") || result.message.includes("CHALLENGE_REQUIRED"))) {
      await db
        .from("ig_accounts")
        .update({ status: "token_expired", updated_at: new Date().toISOString() })
        .eq("id", job.ig_account_id)
        .then(undefined, () => {});
    }

    // If Instagram rate-limited mid-job, extend the cooldown by an extra hour
    // so the user doesn’t immediately retry and get blocked again.
    if (result.status === 'failed' && result.message?.includes("IG_RATE_LIMITED")) {
      const extendedAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
      await db
        .from("ig_accounts")
        .update({ last_snapshot_at: extendedAt, updated_at: new Date().toISOString() })
        .eq("id", job.ig_account_id)
        .then(undefined, () => {});
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
