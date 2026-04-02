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
import { fetchEdgeListChunked, IgEdge, FAILURE_MODES, DeviceProfile } from "./instagram.ts";
import { computeSnapshotDiff }                     from "./diff.ts";
import { writeDiff, loadPreviousSnapshot }          from "./diff_writer.ts";
import { sendPushNotification }                    from "./push.ts";

// ── Cursor helpers ────────────────────────────────────────────────────
// The rank_token must stay consistent across invocations for Instagram’s
// big_list pagination to work correctly. We encode it alongside the cursor
// in the DB column as "cursor|rankToken" so no schema change is needed.

function parseCursorField(raw: string | null): { cursor: string | null; rankToken: string | null } {
  if (!raw) return { cursor: null, rankToken: null };
  const sep = raw.indexOf('|');
  if (sep === -1) return { cursor: raw, rankToken: null };
  return { cursor: raw.substring(0, sep) || null, rankToken: raw.substring(sep + 1) || null };
}

function encodeCursorField(cursor: string | null, rankToken: string): string | null {
  if (!cursor) return null;
  return `${cursor}|${rankToken}`;
}

/** Deduplicate edges by ig_id (preferred) or username fallback. */
function deduplicateEdges(edges: IgEdge[]): IgEdge[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Constants ──────────────────────────────────────────────────────────────
/** Wall-clock budget per invocation (ms). Leaves ~75 s headroom before 150 s limit. */
const TIME_BUDGET_MS          = 75_000;
/** Safety cap on Instagram pages per invocation.
 *  big_list accounts return ~20 users/page, so 45 pages ≈ 900 followers. */
const MAX_PAGES_PER_INVOCATION = 45;
/** Minimum remaining time (ms) to auto-advance to the next phase in the same call. */
const ADVANCE_THRESHOLD_MS    = 15_000;

// ── ETA estimation ────────────────────────────────────────────────────────────

/**
 * Fetch the last few completed non-first-snapshot durations for an IG account.
 * Used as the historical baseline for ETA estimation.
 */
async function fetchHistoricalDurations(
  // deno-lint-ignore no-explicit-any
  db: any,
  igAccountId: string,
): Promise<number[]> {
  const { data } = await db
    .from("snapshot_jobs")
    .select("total_duration_ms")
    .eq("ig_account_id", igAccountId)
    .eq("status", "complete")
    .eq("is_first_snapshot", false)
    .not("total_duration_ms", "is", null)
    .order("completed_at", { ascending: false })
    .limit(3);

  if (!data) return [];
  return data
    .map((r: { total_duration_ms: number | null }) => r.total_duration_ms)
    .filter((d: number | null): d is number => d !== null && d > 0);
}

/**
 * Returns estimated remaining milliseconds for a running snapshot job.
 *
 * Strategy:
 *   1. First snapshots → always null (no reliable baseline exists).
 *   2. Non-first snapshots → use the median of prior completed (non-first)
 *      snapshot durations for this account, plus a 10 % conservative buffer.
 *      ETA = bufferedMedian − elapsed.  Suppressed when exceeded.
 *   3. No historical data → null (show no ETA rather than a bad guess).
 *   4. Finalize phase → 0 ("Finishing up").
 */
function computeEtaMs(
  startedAt:            string | null,
  isFirstSnapshot:      boolean,
  phase:                string,
  historicalDurations:  number[],
): number | null {
  // First snapshot: always suppress — there is no trustworthy baseline.
  if (isFirstSnapshot) return null;

  // Finalize phase: we are genuinely finishing.
  if (phase === "finalize") return 0;

  // Need started_at for elapsed calculation.
  if (!startedAt) return null;

  // No historical data: suppress rather than guess.
  if (historicalDurations.length === 0) return null;

  // Median of historical durations.
  const sorted = [...historicalDurations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];

  // Add a 10 % conservative buffer so the estimate errs on the slow side.
  const expected = Math.round(median * 1.1);

  const elapsed   = Date.now() - new Date(startedAt).getTime();
  const remaining = expected - elapsed;

  // If we have exceeded the buffered historical estimate, suppress
  // rather than show a misleading number.  The phase detail and
  // progress bar still give the user useful feedback.
  if (remaining <= 0) return null;

  return remaining;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface SnapshotJobRow {
  id: string;
  user_id: string;
  ig_account_id: string;
  source: string;
  status: "running" | "complete" | "failed" | "queued";
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
  // Safety fields (020_snapshot_safety)
  device_ua: string | null;
  device_id: string | null;
  android_id: string | null;
  warmup_done: boolean;
  is_first_snapshot: boolean;
  // Telemetry fields (021_snapshot_telemetry)
  started_at: string | null;
  completed_at: string | null;
  total_duration_ms: number | null;
}

export interface ChunkResult {
  jobId: string;
  status: "running" | "complete" | "failed" | "queued";
  phase: string;
  pagesDone: number;
  followersSeen: number;
  followingSeen: number;
  followerCountApi: number;
  followingCountApi: number;
  done: boolean;
  message: string;
  followingCached: boolean;
  /** Estimated milliseconds remaining. null when estimate is not yet reliable. */
  etaMs: number | null;
  /** True when this is the account's first-ever snapshot (ultra-safe pacing). */
  isFirstSnapshot: boolean;
  /** True when snapshot-start found an existing running job and returned it. */
  resumed: boolean;
  /**
   * Count of confirmed "doesn't follow back" users found so far.
   * Only meaningful during the following phase (0 at all other phases).
   * Derived in-memory — no schema change required.
   */
  partialNotFollowingBackCount: number;
  /** First few confirmed "doesn't follow back" users for live preview (following phase only). */
  partialNotFollowingBackPreview: Array<{ig_id: string; username: string}>;
  /** True once the followers phase is fully complete and the following scan has begun. */
  partialResultsReady: boolean;
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

  // Historical durations for ETA estimation — queried once per invocation.
  const historicalDurations = await fetchHistoricalDurations(db, job.ig_account_id);

  // Telemetry: track pages and edges at the start of this invocation for structured logging.
  const pagesAtStart = job.pages_done;
  // Whether the following list will be served from cache — pre-filled following_json
  // with no cursor means the following phase will skip the Instagram API fetch.
  const followingWillBeCached = Array.isArray(job.following_json) &&
    (job.following_json as unknown[]).length > 0 && job.following_cursor === null;

  // Build a stable device profile from the job-persisted fingerprint.
  // Falls back to undefined for legacy jobs created before 020_snapshot_safety.
  const deviceProfile: DeviceProfile | undefined = job.device_ua
    ? { ua: job.device_ua, deviceId: job.device_id ?? "", androidId: job.android_id ?? "" }
    : undefined;

  // Ultra-safe mode uses a lower page cap for first-ever snapshots.
  const safeMaxPages = job.is_first_snapshot ? 20 : MAX_PAGES_PER_INVOCATION;

  // Helper: how many ms remain in this invocation's budget.
  const remaining = () => TIME_BUDGET_MS - (Date.now() - invocationStart);

  let phase      = job.phase;
  let followers  = Array.isArray(job.followers_json) ? [...job.followers_json] : [];
  let following  = Array.isArray(job.following_json) ? [...job.following_json] : [];
  let pagesDone  = job.pages_done;
  let followersCursor = job.followers_cursor;
  let followingCursor = job.following_cursor;
  let followingFromCache = false;

  // Shorthand that auto-populates API counts from the job row
  const mk = (
    status: "running" | "complete" | "failed", p: string,
    pd: number, fs: number, fws: number, done: boolean, msg: string, fwc = false, eta: number | null = null,
  ) => makeResult(job.id, status, p, pd, fs, fws, done, msg, fwc, job.follower_count_api, job.following_count_api, job.is_first_snapshot, eta);

  // ── Phase: followers ─────────────────────────────────────────────────────
  if (phase === "followers") {
    const { cursor: actualFollowersCursor, rankToken: savedRankToken } = parseCursorField(followersCursor);

    const result = await fetchEdgeListChunked(igUserId, "followers", cookie, {
      startCursor:  actualFollowersCursor,
      rankToken:    savedRankToken ?? undefined,
      timeBudgetMs: remaining() - 5_000,  // 5 s margin for DB writes
      maxPages:     safeMaxPages,
      deviceProfile,
      skipWarmup:   job.warmup_done,
      ultraSafe:    job.is_first_snapshot,
    });

    followers    = deduplicateEdges([...followers, ...result.edges]);
    pagesDone   += result.pagesFetched;
    followersCursor = encodeCursorField(result.nextCursor, result.rankToken);

    if (result.stopReason && result.stopReason !== "PAGE_LIMIT_REACHED") {
      // Fatal Instagram error — fail the job
      const mode = FAILURE_MODES[result.stopReason];
      await failJob(db, job.id, mode?.uiMessage ?? result.stopReason, job.started_at);
      return mk("failed", phase, pagesDone, followers.length, following.length, true, mode?.uiMessage ?? result.stopReason);
    }

    const followersPhaseDone = result.isComplete || result.nextCursor === null;

    // Persist follower progress (mark warmup done so subsequent invocations skip it)
    const followerInvMs = Date.now() - invocationStart;
    console.log(`[timing] job=${job.id} phase=followers invocation_ms=${followerInvMs} pages_this_inv=${pagesDone - pagesAtStart} edges_total=${followers.length}`);
    await db.from("snapshot_jobs").update({
      followers_json:   followers,
      followers_cursor: followersPhaseDone ? null : followersCursor,
      phase:            followersPhaseDone ? "following" : "followers",
      pages_done:       pagesDone,
      warmup_done:      true,
      updated_at:       new Date().toISOString(),
    }).eq("id", job.id);

    if (followersPhaseDone) {
      phase = "following";
      console.log(`[job ${job.id}] followers complete (${followers.length} edges). Advancing to following.`);
    } else {
      console.log(`[job ${job.id}] followers chunk done: ${followers.length} so far, cursor saved.`);
      const eta = computeEtaMs(job.started_at, job.is_first_snapshot, "followers", historicalDurations);
      return mk("running", "followers", pagesDone, followers.length, following.length, false, `Fetched ${followers.length} followers so far…`, false, eta);
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
        const eta = computeEtaMs(job.started_at, job.is_first_snapshot, "following", historicalDurations);
        // Followers are complete; compute confirmed partial NFB from whatever following we have.
        const nfb = computePartialNfb(followers, following);
        const base = mk("running", "following", pagesDone, followers.length, following.length, false, "Fetching following list\u2026", false, eta);
        return { ...base, partialNotFollowingBackCount: nfb.count, partialNotFollowingBackPreview: nfb.preview, partialResultsReady: true };
      }

      const { cursor: actualFollowingCursor, rankToken: savedFollowingRankToken } = parseCursorField(followingCursor);

      const result = await fetchEdgeListChunked(igUserId, "following", cookie, {
        startCursor:  actualFollowingCursor,
        rankToken:    savedFollowingRankToken ?? undefined,
        timeBudgetMs: remaining() - 5_000,
        maxPages:     safeMaxPages,
        deviceProfile,
        skipWarmup:   true,  // warmup already done during followers phase
        ultraSafe:    job.is_first_snapshot,
      });

      following    = deduplicateEdges([...following, ...result.edges]);
      pagesDone   += result.pagesFetched;
      followingCursor = encodeCursorField(result.nextCursor, result.rankToken);

      if (result.stopReason && result.stopReason !== "PAGE_LIMIT_REACHED") {
        const mode = FAILURE_MODES[result.stopReason];
        await failJob(db, job.id, mode?.uiMessage ?? result.stopReason, job.started_at);
        return mk("failed", phase, pagesDone, followers.length, following.length, true, mode?.uiMessage ?? result.stopReason);
      }

      const followingPhaseDone = result.isComplete || result.nextCursor === null;

      const followingInvMs = Date.now() - invocationStart;
      console.log(`[timing] job=${job.id} phase=following invocation_ms=${followingInvMs} pages_this_inv=${pagesDone - pagesAtStart} edges_total=${following.length}`);
      await db.from("snapshot_jobs").update({
        following_json:   following,
        following_cursor: followingPhaseDone ? null : followingCursor,
        phase:            followingPhaseDone ? "finalize" : "following",
        pages_done:       pagesDone,
        warmup_done:      true,
        updated_at:       new Date().toISOString(),
      }).eq("id", job.id);

      if (followingPhaseDone) {
        phase = "finalize";
        console.log(`[job ${job.id}] following complete (${following.length} edges). Advancing to finalize.`);
      } else {
        console.log(`[job ${job.id}] following chunk done: ${following.length} so far.`);
        const eta = computeEtaMs(job.started_at, job.is_first_snapshot, "following", historicalDurations);
        // Emit confirmed partial NFB from everything fetched so far.
        const nfb = computePartialNfb(followers, following);
        const base = mk("running", "following", pagesDone, followers.length, following.length, false, "Fetching following list\u2026", false, eta);
        return { ...base, partialNotFollowingBackCount: nfb.count, partialNotFollowingBackPreview: nfb.preview, partialResultsReady: true };
      }
    }
  }

  // ── Phase: finalize ───────────────────────────────────────────────────────
  if (phase === "finalize") {
    try {
      const capturedAt = job.captured_at ?? new Date().toISOString();
      const igAccountId = job.ig_account_id;

      // When the list fetch completed fully (no remaining cursor), the edge
      // array *is* the source of truth. The API profile count is cached and
      // can lag behind reality. Only prefer the API count when the capture
      // was partial so we don't underreport.
      const isListComplete = job.followers_cursor === null && job.following_cursor === null;
      const followerCount  = isListComplete
        ? followers.length
        : Math.max(job.follower_count_api ?? 0, followers.length);
      const followingCount = isListComplete
        ? following.length
        : Math.max(job.following_count_api ?? 0, following.length);

      // Mutual count
      const followerKeySet = new Set(
        followers.map((e: IgEdge) => e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
      );
      const mutualCount = following.filter(
        (e: IgEdge) => followerKeySet.has(e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
      ).length;

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

      // Mark job complete — conditional: only if the job is still "running".
      // If two requests race into finalize, the second one will match 0 rows
      // and skip the push, preventing a duplicate notification.
      const finalizedAt = new Date().toISOString();
      const totalDurationMs = job.started_at
        ? Date.now() - new Date(job.started_at).getTime()
        : null;
      console.log(`[timing] job=${job.id} phase=finalize total_ms=${totalDurationMs ?? 'unknown'} pages_done=${pagesDone} followers=${followers.length} following=${following.length}`);
      const { data: markedComplete } = await db.from("snapshot_jobs").update({
        status:            "complete",
        phase:             "finalize",
        completed_at:      finalizedAt,
        total_duration_ms: totalDurationMs,
        updated_at:        finalizedAt,
      })
        .eq("id", job.id)
        .eq("status", "running")
        .select("id")
        .maybeSingle();

      // ── Send "snapshot ready" push notification ─────────────────────
      // Only send if we were the request that flipped status →0 complete.
      if (markedComplete) try {
        const { data: profile } = await db
          .from("profiles")
          .select("push_token")
          .eq("id", job.user_id)
          .maybeSingle();

        const { data: notifPrefs } = await db
          .from("user_settings")
          .select("notify_refresh_complete")
          .eq("user_id", job.user_id)
          .maybeSingle();

        const shouldNotify = profile?.push_token &&
          (notifPrefs?.notify_refresh_complete ?? true);

        if (shouldNotify) {
          // Build a personalised body using diff data when available
          let body = "Your latest snapshot is ready. Open StayReel to see your results.";

          if (diffId) {
            const { data: diffRow } = await db
              .from("diffs")
              .select("net_follower_change, lost_followers")
              .eq("id", diffId)
              .maybeSingle();

            if (diffRow) {
              const net = diffRow.net_follower_change ?? 0;
              const lost = Array.isArray(diffRow.lost_followers) ? diffRow.lost_followers.length : 0;

              if (net > 0) {
                body = `You gained ${net} follower${net !== 1 ? "s" : ""} since your last snapshot! 📈`;
              } else if (lost > 0) {
                body = `${lost} account${lost !== 1 ? "s" : ""} unfollowed since last time. Tap to see who.`;
              } else {
                body = "Snapshot complete — no follower changes detected. You\u2019re all good! \u2713";
              }
            }
          }

          await sendPushNotification(
            profile.push_token,
            "Snapshot Ready \uD83D\uDCF8",
            body,
            { screen: "dashboard" },
          );
          console.log(`[job ${job.id}] push notification sent.`);
        }
      } catch (notifErr) {
        // Non-fatal — never let a notification failure break the snapshot flow
        console.warn("[job finalize] push notification error:", (notifErr as Error).message);
      }

      console.log(`[job ${job.id}] finalized: snapshot ${snapshot.id}, ${followerCount} followers, ${followingCount} following`);
      return mk("complete", "finalize", pagesDone, followers.length, following.length, true, "Snapshot complete.", followingFromCache);

    } catch (err) {
      const msg = (err as Error).message ?? "Finalization error";
      await failJob(db, job.id, msg, job.started_at);
      return mk("failed", "finalize", pagesDone, followers.length, following.length, true, msg);
    }
  }

  // Should never reach here
  return mk("failed", phase, pagesDone, followers.length, following.length, true, "Unknown phase");
}

// ── Helpers ────────────────────────────────────────────────────────────────

// deno-lint-ignore no-explicit-any
async function failJob(db: any, jobId: string, error: string, startedAt?: string | null): Promise<void> {
  const failedAt = new Date().toISOString();
  const totalDurationMs = startedAt ? Date.now() - new Date(startedAt).getTime() : null;
  await db.from("snapshot_jobs").update({
    status:            "failed",
    error,
    completed_at:      failedAt,
    total_duration_ms: totalDurationMs,
    updated_at:        failedAt,
  }).eq("id", jobId);
}

/**
 * Derive confirmed "doesn't follow back" entries from the accumulated lists.
 * Only call once the followers phase is fully complete.
 * Building the Set is O(followers) ≈ <1 ms even at 5 000 entries.
 */
function computePartialNfb(
  followers: IgEdge[],
  following: IgEdge[],
  maxPreview = 5,
): { count: number; preview: Array<{ig_id: string; username: string}> } {
  const followersSet = new Set(
    followers.map((e) => e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
  );
  const nfb = following.filter(
    (e) => !followersSet.has(e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
  );
  return {
    count:   nfb.length,
    preview: nfb.slice(0, maxPreview).map((e) => ({ ig_id: e.ig_id ?? "", username: e.username })),
  };
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
  followerCountApi = 0,
  followingCountApi = 0,
  isFirstSnapshot = false,
  etaMs: number | null = null,
  resumed = false,
): ChunkResult {
  return { jobId, status, phase, pagesDone, followersSeen, followingSeen, followerCountApi, followingCountApi, done, message, followingCached, isFirstSnapshot, etaMs, resumed, partialNotFollowingBackCount: 0, partialNotFollowingBackPreview: [], partialResultsReady: false };
}
