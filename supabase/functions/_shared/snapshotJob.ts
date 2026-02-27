/// <reference path="../deno-types.d.ts" />
// _shared/snapshotJob.ts
//
// Core worker for the resumable snapshot job system.
//
// Each call to `runSnapshotChunk` does one unit of work for a job:
//
//   Phase "followers": paginate followers from Instagram until time budget
//                      or max-pages-per-invocation is hit, then persist.
//   Phase "following": paginate following list (usually fits in one call).
//   Phase "finalize" : write follower_snapshots row, follower_edges, diff,
//                      update ig_accounts streak — then mark job complete.
//
// State is persisted to the `snapshot_jobs` DB row after each chunk so
// the next Edge Function invocation can resume exactly where this one ended.

import { adminClient }                              from "./supabase_client.ts";
import { fetchEdgeListChunked, IgEdge, FAILURE_MODES } from "./instagram.ts";
import { computeSnapshotDiff }                     from "./diff.ts";
import { writeDiff, loadPreviousSnapshot }          from "./diff_writer.ts";

// ── Constants ──────────────────────────────────────────────────────────────
/** Wall-clock budget per invocation (ms). Leaves ~75 s headroom before 150 s limit. */
const TIME_BUDGET_MS          = 75_000;
/** Safety cap on Instagram pages per invocation.
 *  big_list accounts return ~20 users/page, so 45 pages ≈ 900 followers. */
const MAX_PAGES_PER_INVOCATION = 45;
/** Minimum remaining time (ms) to auto-advance to the next phase in the same call. */
const ADVANCE_THRESHOLD_MS    = 15_000;

// ── Types ──────────────────────────────────────────────────────────────────
export interface SnapshotJobRow {
  id: string;
  user_id: string;
  ig_account_id: string;
  source: string;
  status: "running" | "complete" | "failed";
  phase: "followers" | "following" | "finalize";
  followers_cursor: string | null;
  following_cursor: string | null;
  followers_json: IgEdge[];
  following_json: IgEdge[];
  follower_count_api: number;
  following_count_api: number;
  post_count_api: number;
  captured_at: string | null;
  pages_done: number;
  error: string | null;
  updated_at: string | null;
}

export interface ChunkResult {
  jobId: string;
  status: "running" | "complete" | "failed";
  phase: string;
  pagesDone: number;
  followersSeen: number;
  followingSeen: number;
  done: boolean;
  message: string;
  followingCached: boolean;
}

// ── Main worker ────────────────────────────────────────────────────────────

/**
 * Processes one chunk of work for the given snapshot job.
 *
 * @param job      Current DB row for the job (already loaded by caller).
 * @param cookie   Decrypted Instagram session cookie.
 * @param igUserId Instagram numeric user ID (from ig_accounts.ig_user_id).
 */
export async function runSnapshotChunk(
  job: SnapshotJobRow,
  cookie: string,
  igUserId: string,
): Promise<ChunkResult> {
  const invocationStart = Date.now();
  const db = adminClient();

  // Helper: how many ms remain in this invocation's budget.
  const remaining = () => TIME_BUDGET_MS - (Date.now() - invocationStart);

  let phase      = job.phase;
  let followers  = Array.isArray(job.followers_json) ? [...job.followers_json] : [];
  let following  = Array.isArray(job.following_json) ? [...job.following_json] : [];
  let pagesDone  = job.pages_done;
  let followersCursor = job.followers_cursor;
  let followingCursor = job.following_cursor;
  let followingFromCache = false;

  // ── Phase: followers ─────────────────────────────────────────────────────
  if (phase === "followers") {
    const result = await fetchEdgeListChunked(igUserId, "followers", cookie, {
      startCursor:  followersCursor,
      timeBudgetMs: remaining() - 5_000,  // 5 s margin for DB writes
      maxPages:     MAX_PAGES_PER_INVOCATION,
    });

    followers    = [...followers, ...result.edges];
    pagesDone   += result.pagesFetched;
    followersCursor = result.nextCursor;

    if (result.stopReason && result.stopReason !== "PAGE_LIMIT_REACHED") {
      // Fatal Instagram error — fail the job
      const mode = FAILURE_MODES[result.stopReason];
      await failJob(db, job.id, mode?.uiMessage ?? result.stopReason);
      return makeResult(job.id, "failed", phase, pagesDone, followers.length, following.length, true, mode?.uiMessage ?? result.stopReason);
    }

    const followersPhaseDone = result.isComplete || result.nextCursor === null;

    // Persist follower progress
    await db.from("snapshot_jobs").update({
      followers_json:   followers,
      followers_cursor: followersPhaseDone ? null : followersCursor,
      phase:            followersPhaseDone ? "following" : "followers",
      pages_done:       pagesDone,
      updated_at:       new Date().toISOString(),
    }).eq("id", job.id);

    if (followersPhaseDone) {
      phase = "following";
      console.log(`[job ${job.id}] followers complete (${followers.length} edges). Advancing to following.`);
    } else {
      console.log(`[job ${job.id}] followers chunk done: ${followers.length} so far, cursor saved.`);
      return makeResult(job.id, "running", "followers", pagesDone, followers.length, following.length, false, `Fetched ${followers.length} followers so far…`);
    }
  }

  // ── Phase: following ─────────────────────────────────────────────────────
  if (phase === "following") {
    // Cache hit: following was pre-populated from a snapshot taken earlier today.
    // Only refresh the following list once per 24 h to protect the account.
    if (following.length > 0 && followingCursor === null) {
      console.log(`[job ${job.id}] following served from cache (${following.length} edges). Skipping API fetch.`);
      followingFromCache = true;
      await db.from("snapshot_jobs").update({
        phase:      "finalize",
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);
      phase = "finalize";
    } else {
      const rem = remaining();
      if (rem < ADVANCE_THRESHOLD_MS) {
        // Not enough time — defer to next invocation
        console.log(`[job ${job.id}] following deferred (${rem}ms remaining)`);
        return makeResult(job.id, "running", "following", pagesDone, followers.length, following.length, false, "Fetching following list…");
      }

      const result = await fetchEdgeListChunked(igUserId, "following", cookie, {
        startCursor:  followingCursor,
        timeBudgetMs: remaining() - 5_000,
        maxPages:     MAX_PAGES_PER_INVOCATION,
      });

      following    = [...following, ...result.edges];
      pagesDone   += result.pagesFetched;
      followingCursor = result.nextCursor;

      if (result.stopReason && result.stopReason !== "PAGE_LIMIT_REACHED") {
        const mode = FAILURE_MODES[result.stopReason];
        await failJob(db, job.id, mode?.uiMessage ?? result.stopReason);
        return makeResult(job.id, "failed", phase, pagesDone, followers.length, following.length, true, mode?.uiMessage ?? result.stopReason);
      }

      const followingPhaseDone = result.isComplete || result.nextCursor === null;

      await db.from("snapshot_jobs").update({
        following_json:   following,
        following_cursor: followingPhaseDone ? null : followingCursor,
        phase:            followingPhaseDone ? "finalize" : "following",
        pages_done:       pagesDone,
        updated_at:       new Date().toISOString(),
      }).eq("id", job.id);

      if (followingPhaseDone) {
        phase = "finalize";
        console.log(`[job ${job.id}] following complete (${following.length} edges). Advancing to finalize.`);
      } else {
        console.log(`[job ${job.id}] following chunk done: ${following.length} so far.`);
        return makeResult(job.id, "running", "following", pagesDone, followers.length, following.length, false, "Fetching following list…");
      }
    }
  }

  // ── Phase: finalize ───────────────────────────────────────────────────────
  if (phase === "finalize") {
    try {
      const capturedAt = job.captured_at ?? new Date().toISOString();
      const igAccountId = job.ig_account_id;

      const followerCount  = Math.max(job.follower_count_api ?? 0, followers.length);
      const followingCount = Math.max(job.following_count_api ?? 0, following.length);

      // Mutual count
      const followerKeySet = new Set(
        followers.map((e: IgEdge) => e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
      );
      const mutualCount = following.filter(
        (e: IgEdge) => followerKeySet.has(e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
      ).length;

      const isListComplete = job.followers_cursor === null && job.following_cursor === null;

      // Insert follower_snapshots row
      const { data: snapshot, error: snapErr } = await db
        .from("follower_snapshots")
        .insert({
          ig_account_id:   igAccountId,
          captured_at:     capturedAt,
          source:          job.source,
          follower_count:  followerCount,
          following_count: followingCount,
          post_count:      job.post_count_api,
          followers_json:  followers,
          following_json:  following,
          is_list_complete: isListComplete,
          mutual_count:    mutualCount,
          error_message:   isListComplete ? null : "Partial capture (large account)",
        })
        .select("id, follower_count, following_count")
        .single();

      if (snapErr || !snapshot) {
        throw new Error(`Snapshot insert failed: ${snapErr?.message}`);
      }

      // Insert follower_edges in chunks of 500
      if (followers.length > 0) {
        const edgeRows = followers.map((e: IgEdge) => ({
          ig_account_id:     igAccountId,
          snapshot_id:       snapshot.id,
          captured_at:       capturedAt,
          follower_ig_id:    e.ig_id || null,
          follower_username: e.username,
        }));
        const CHUNK = 500;
        for (let i = 0; i < edgeRows.length; i += CHUNK) {
          const { error: edgeErr } = await db.from("follower_edges").insert(edgeRows.slice(i, i + CHUNK));
          if (edgeErr) console.error("[job finalize] follower_edges insert error:", edgeErr.message);
        }
      }

      // Compute diff vs previous snapshot
      let diffId: string | null = null;
      const prev = await loadPreviousSnapshot(igAccountId, snapshot.id);
      if (prev) {
        const diff = computeSnapshotDiff(
          {
            prevFollowers:         prev.followerList,
            currFollowers:         followers,
            prevFollowing:         prev.followingList,
            currFollowing:         following,
            prevFollowerCountApi:  job.follower_count_api || prev.followerCount,
            currFollowerCountApi:  job.follower_count_api,
            prevFollowingCountApi: job.following_count_api || prev.followingCount,
            currFollowingCountApi: job.following_count_api,
          },
          isListComplete,
        );
        const writeResult = await writeDiff({
          igAccountId,
          fromSnapshotId:  prev.id,
          toSnapshotId:    snapshot.id,
          fromCapturedAt:  prev.capturedAt,
          toCapturedAt:    capturedAt,
          diff,
        });
        if (writeResult.ok) diffId = writeResult.diffId;
        else console.error("[job finalize] diff write error:", writeResult.error);
      }

      // Update streak + ig_accounts
      const { data: acctStreak } = await db
        .from("ig_accounts")
        .select("current_streak_days, longest_streak_days")
        .eq("id", igAccountId)
        .maybeSingle();

      let newStreak  = acctStreak?.current_streak_days ?? 0;
      let newLongest = acctStreak?.longest_streak_days ?? 0;

      if (diffId) {
        const { data: diffRow } = await db.from("diffs").select("net_follower_change").eq("id", diffId).maybeSingle();
        const net = diffRow?.net_follower_change ?? 0;
        newStreak  = net >= 0 ? newStreak + 1 : 0;
        newLongest = Math.max(newLongest, newStreak);
      }

      await db.from("ig_accounts").update({
        last_verified_at:    capturedAt,
        last_snapshot_at:    capturedAt,
        status:              "active",
        updated_at:          capturedAt,
        current_streak_days: newStreak,
        longest_streak_days: newLongest,
      }).eq("id", igAccountId);

      // Mark job complete
      await db.from("snapshot_jobs").update({
        status:     "complete",
        phase:      "finalize",
        updated_at: new Date().toISOString(),
      }).eq("id", job.id);

      console.log(`[job ${job.id}] finalized: snapshot ${snapshot.id}, ${followerCount} followers, ${followingCount} following`);
      return makeResult(job.id, "complete", "finalize", pagesDone, followers.length, following.length, true, "Snapshot complete.", followingFromCache);

    } catch (err) {
      const msg = (err as Error).message ?? "Finalization error";
      await failJob(db, job.id, msg);
      return makeResult(job.id, "failed", "finalize", pagesDone, followers.length, following.length, true, msg);
    }
  }

  // Should never reach here
  return makeResult(job.id, "failed", phase, pagesDone, followers.length, following.length, true, "Unknown phase");
}

// ── Helpers ────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function failJob(db: any, jobId: string, error: string): Promise<void> {
  await db.from("snapshot_jobs").update({
    status:     "failed",
    error,
    updated_at: new Date().toISOString(),
  }).eq("id", jobId);
}

function makeResult(
  jobId: string,
  status: "running" | "complete" | "failed",
  phase: string,
  pagesDone: number,
  followersSeen: number,
  followingSeen: number,
  done: boolean,
  message: string,
  followingCached = false,
): ChunkResult {
  return { jobId, status, phase, pagesDone, followersSeen, followingSeen, done, message, followingCached };
}
