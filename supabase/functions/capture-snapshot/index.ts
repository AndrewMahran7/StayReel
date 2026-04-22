/// <reference path="../deno-types.d.ts" />
// capture-snapshot/index.ts
//
// Legacy endpoint kept only as an explicit 410 response so old clients fail
// fast without keeping an unused snapshot path alive in the codebase.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  // DISABLED: superseded by /snapshot-start + /snapshot-continue
  return jsonResponse(
    {
      error:   "ENDPOINT_DISABLED",
      message: "This endpoint has been replaced by /snapshot-start and /snapshot-continue. Please update your client.",
    },
    410,
  );

    // Mutual count: users present in both followers and following
    const followerKeySet = new Set(
      followers.map((e: IgEdge) => e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
    );
    const mutualCount = following.filter(
      (e: IgEdge) => followerKeySet.has(e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`),
    ).length;

    // When stopped early, humanise the stop reason for the error_message column.
    const stopMessage = igMeta.stop_reason
      ? FAILURE_MODES[igMeta.stop_reason]?.uiMessage ?? igMeta.stop_reason
      : null;

    const { data: snapshot, error: snapErr } = await adminClient()
      .from("follower_snapshots")
      .insert({
        ig_account_id: igAccountId,
        captured_at: capturedAt,
        source,
        follower_count: followerCount,
        following_count: followingCount,
        post_count: igMeta.post_count_api,
        followers_json: followers,
        following_json: following,
        is_list_complete: isListComplete,
        mutual_count: mutualCount,
        error_message: stopMessage,
      })
      .select("id, follower_count, following_count")
      .single();

    if (snapErr || !snapshot) {
      throw Errors.internal(`Snapshot insert failed: ${snapErr?.message}`);
    }

    // ── 8. Write follower_edges (normalised rows) ─────────────
    if (followers.length > 0) {
      const edgeRows = followers.map((e: IgEdge) => ({
        ig_account_id: igAccountId,
        snapshot_id: snapshot.id,
        captured_at: capturedAt,
        follower_ig_id: e.ig_id || null,
        follower_username: e.username,
      }));

      // Batch-insert in chunks of 500 to stay within payload limits
      const CHUNK = 500;
      for (let i = 0; i < edgeRows.length; i += CHUNK) {
        const { error: edgeErr } = await adminClient()
          .from("follower_edges")
          .insert(edgeRows.slice(i, i + CHUNK));

        if (edgeErr) {
          // Non-fatal: log and continue — counts are already saved.
          console.error("[capture] follower_edges insert error:", edgeErr.message);
        }
      }
    }

    // ── 9. Compute diff vs. previous snapshot ────────────────
    let diffId: string | null = null;

    const prev = await loadPreviousSnapshot(igAccountId, snapshot.id);

    if (prev) {
      const diff = computeSnapshotDiff(
        {
          prevFollowers:         prev.followerList,
          currFollowers:         followers,
          prevFollowing:         prev.followingList,
          currFollowing:         following,
          prevFollowerCountApi:  igMeta.follower_count_api  || prev.followerCount,
          currFollowerCountApi:  igMeta.follower_count_api,
          prevFollowingCountApi: igMeta.following_count_api || prev.followingCount,
          currFollowingCountApi: igMeta.following_count_api,
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

      if (writeResult.ok) {
        diffId = writeResult.diffId;
      } else {
        console.error("[capture] diff write error:", writeResult.error);
      }
    }

    // ── 10. Compute streak + update ig_accounts ─────────────
    // Streak increments when net follower change >= 0, resets on negative.
    const { data: acctStreak } = await adminClient()
      .from("ig_accounts")
      .select("current_streak_days, longest_streak_days")
      .eq("id", igAccountId)
      .maybeSingle();

    let newStreak  = acctStreak?.current_streak_days ?? 0;
    let newLongest = acctStreak?.longest_streak_days ?? 0;

    if (diffId) {
      const { data: diffRow } = await adminClient()
        .from("diffs")
        .select("net_follower_change")
        .eq("id", diffId)
        .maybeSingle();
      const net = diffRow?.net_follower_change ?? 0;
      newStreak  = net >= 0 ? newStreak + 1 : 0;
      newLongest = Math.max(newLongest, newStreak);
    }

    await adminClient()
      .from("ig_accounts")
      .update({
        last_verified_at:    capturedAt,
        last_snapshot_at:    capturedAt,
        status:              "active",
        updated_at:          capturedAt,
        current_streak_days: newStreak,
        longest_streak_days: newLongest,
      })
      .eq("id", igAccountId);

    // ── 11. Audit ─────────────────────────────────────────────
    await writeAuditEvent({
      userId,
      igAccountId,
      eventType: "snapshot_taken",
      payload: {
        snapshot_id: snapshot.id,
        diff_id: diffId,
        follower_count: followerCount,
        following_count: followingCount,
        is_list_complete: isListComplete,
        source,
      },
      ipAddress: extractIp(req),
    });

    return jsonResponse({
      snapshot_id: snapshot.id,
      diff_id: diffId,
      follower_count: followerCount,
      following_count: followingCount,
      captured_at: capturedAt,
      is_list_complete: isListComplete,
    });
  } catch (err) {
    // ── Error audit ───────────────────────────────────────────
    const code =
      err instanceof AppError ? err.code : "UNKNOWN";

    await writeAuditEvent({
      userId: userId ?? null,
      igAccountId: igAccountId ?? null,
      eventType: "snapshot_failed",
      payload: { error_code: code, message: String((err as Error).message) },
    }).catch(() => {});

    // Mark account status on session/challenge errors
    if (
      igAccountId &&
      err instanceof AppError &&
      (err.code === "IG_SESSION_INVALID" ||
        err.code === "IG_CHALLENGE_REQUIRED")
    ) {
      await adminClient()
        .from("ig_accounts")
        .update({ status: "token_expired", updated_at: new Date().toISOString() })
        .eq("id", igAccountId)
        .then(undefined, () => {});
    }

    return errorResponse(err);
  }
});
