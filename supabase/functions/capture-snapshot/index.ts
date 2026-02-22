/// <reference path="../deno-types.d.ts" />
// capture-snapshot/index.ts
//
// POST /capture-snapshot
// Body: { "ig_account_id": "<uuid>", "source": "manual" | "cron" }
//
// 1. Auth + ownership check.
// 2. Cadence guard (minimum 6 hours between snapshots).
// 3. Rate limit (manual: max 2/day; cron: no cap).
// 4. Retrieve session cookie from Vault.
// 5. Fetch followers + following via fetchUserList() — max 5 pages, backoff, challenge-aware.
// 6. Write follower_snapshots row (counts + JSON blob + source + stop_reason).
// 7. Write follower_edges rows (normalised, for set-diff queries).
// 8. Compute diff vs. previous snapshot → write diffs row.
// 9. Update ig_accounts.last_verified_at, status.
// 10. Audit.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors, AppError } from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";
import { writeAuditEvent, extractIp } from "../_shared/audit.ts";
import { checkAndEnforce24hLimit } from "../_shared/rate_limit.ts";
import { fetchUserList, FAILURE_MODES } from "../_shared/instagram.ts";
import { computeSnapshotDiff, IgEdge } from "../_shared/diff.ts";
import { writeDiff, loadPreviousSnapshot } from "../_shared/diff_writer.ts";
import { vaultRetrieve } from "../_shared/vault.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let userId: string | undefined;
  let igAccountId: string | undefined;

  try {
    // ── 1. Auth ─────────────────────────────────────────────
    const caller = await requireAuth(req);
    userId = caller.userId;

    // ── 2. Parse body ────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      throw Errors.badRequest("Request body must be valid JSON.");
    }

    igAccountId = String(body?.ig_account_id ?? "").trim();
    const source = String(body?.source ?? "manual");

    if (!igAccountId) throw Errors.badRequest("ig_account_id is required.");
    if (!["manual", "cron", "onboarding"].includes(source)) {
      throw Errors.badRequest("source must be manual | cron | onboarding");
    }

    // Ownership check (RLS-enforced read)
    await requireOwnsAccount(caller.authHeader, igAccountId);

    // ── 2. Daily snapshot limit (24h per account) ────────────
    if (source === "manual") {
      await checkAndEnforce24hLimit(userId, igAccountId);
    }

    // ── 4. Load IG account row ───────────────────────────────
    const { data: igAccount, error: acctErr } = await adminClient()
      .from("ig_accounts")
      .select(
        "id, ig_user_id, username, vault_secret_id, status, " +
          "follower_count:follower_snapshots(follower_count, following_count, id)",
      )
      .eq("id", igAccountId)
      .is("deleted_at", null)
      .single();

    if (acctErr || !igAccount) throw Errors.notFound("IG account");
    // Cast away GenericStringError – client has no generated DB schema types
    const acct = igAccount as unknown as {
      id: string; ig_user_id: string; username: string;
      vault_secret_id: string | null; status: string;
    };
    if (acct.status === "suspended") {
      throw Errors.forbidden();
    }

    // ── 5. Retrieve session cookie from Vault ────────────────
    if (!acct.vault_secret_id) {
      throw Errors.igSessionInvalid();
    }
    const sessionCookie = await vaultRetrieve(acct.vault_secret_id);

    // ── 6. Fetch followers + following via fetchUserList() ────
    // Always resolves — partial results returned on early stop.
    const igResult = await fetchUserList(sessionCookie, acct.username);
    const { followers, following, meta: igMeta } = igResult;

    const isListComplete = !igMeta.stopped_early;
    const capturedAt    = igMeta.fetched_at;

    // ── 7. Write follower_snapshots row ──────────────────────
    // Use whichever is larger: the API-reported count or the number of edges
    // actually fetched. The API count is accurate when pagination stops early
    // (big_list throttle). The list length wins if the API returns a bogus low
    // number (the /current_user?edit=true endpoint sometimes returns wrong counts).
    const followerCount  = Math.max(igMeta.follower_count_api  ?? 0, followers.length);
    const followingCount = Math.max(igMeta.following_count_api ?? 0, following.length);

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
