/// <reference path="../deno-types.d.ts" />
// smart-notify/index.ts
//
// POST /smart-notify
// Auth: service-role key
//
// Called after an automatic snapshot completes. Compares the latest diff
// to the previous snapshot and sends a push notification only when there
// is a meaningful change.
//
// Notification threshold logic:
//   - Send if abs(net follower change) >= 3
//   - OR send if new unfollowers >= 3
//   - OR if user posted new content since the last snapshot, send if
//     any follower change occurred at all (net != 0)
//
// Content detection:
//   Uses post_count from follower_snapshots to detect new posts.
//   If the current snapshot's post_count > previous snapshot's post_count,
//   the user posted since the last snapshot.
//
// Copy rules:
//   - If new content: lead with "Your audience changed after your latest post"
//   - If no new content: lead with follower-change-focused copy
//
// Audit trail:
//   Updates diffs.notification_sent, notification_reason, notification_skipped_reason

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { sendPushNotification }                from "../_shared/push.ts";

// ── Threshold constants ────────────────────────────────────────
/** Minimum net follower change to trigger a notification (when no new content). */
const NET_FOLLOWER_THRESHOLD = 3;

/** Minimum unfollower count to trigger a notification (when no new content). */
const UNFOLLOWER_THRESHOLD = 3;

/** Minimum gap between auto-snapshot notifications per user (12 hours). */
const NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1_000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();

  // ── Auth ──────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = authHeader.replace("Bearer ", "");

  if (token !== serviceKey) {
    return jsonResponse({ error: "Unauthorized — service role required" }, 401);
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const diffId      = String(body.diff_id ?? "").trim();
  const igAccountId = String(body.ig_account_id ?? "").trim();
  const userId      = String(body.user_id ?? "").trim();
  const jobId       = String(body.job_id ?? "").trim();

  if (!diffId || !igAccountId || !userId) {
    return jsonResponse({ error: "diff_id, ig_account_id, and user_id are required" }, 400);
  }

  const db = adminClient();

  try {
    // ── 1. Load the diff ────────────────────────────────────────
    const { data: diff, error: diffErr } = await db
      .from("diffs")
      .select(`
        id,
        net_follower_change,
        lost_followers,
        new_followers,
        from_snapshot_id,
        to_snapshot_id,
        notification_sent
      `)
      .eq("id", diffId)
      .single();

    if (diffErr || !diff) {
      return jsonResponse({ error: "Diff not found" }, 404);
    }

    // Already notified (idempotency guard)
    if (diff.notification_sent) {
      return jsonResponse({ action: "already_notified", diff_id: diffId });
    }

    // ── 2. Check auto-snapshot opt-in (defense-in-depth) ────────
    // Notifications from auto snapshots should only fire if the user
    // has explicitly opted in to automatic snapshots.
    const { data: igAccount } = await db
      .from("ig_accounts")
      .select("auto_snapshot_enabled")
      .eq("id", igAccountId)
      .maybeSingle();

    if (igAccount && igAccount.auto_snapshot_enabled === false) {
      await markSkipped(db, diffId, "auto_snapshots_disabled");
      await logEvent(db, userId, "auto_snapshot_completed", { ig_account_id: igAccountId, job_id: jobId, notification: "skipped_auto_disabled" });
      return jsonResponse({ action: "skipped", reason: "auto_snapshots_disabled" });
    }

    // ── 3. Check user notification preferences ──────────────────
    const { data: settings } = await db
      .from("user_settings")
      .select("notify_on_meaningful_change")
      .eq("user_id", userId)
      .maybeSingle();

    if (settings && settings.notify_on_meaningful_change === false) {
      await markSkipped(db, diffId, "user_opted_out");
      await logEvent(db, userId, "auto_snapshot_completed", { ig_account_id: igAccountId, job_id: jobId, notification: "skipped_opted_out" });
      return jsonResponse({ action: "skipped", reason: "user_opted_out" });
    }

    // ── 4. Get push token + cooldown check ───────────────────
    const { data: profile } = await db
      .from("profiles")
      .select("push_token, last_notification_sent_at")
      .eq("id", userId)
      .maybeSingle();

    if (!profile?.push_token) {
      await markSkipped(db, diffId, "no_push_token");
      await logEvent(db, userId, "auto_snapshot_completed", { ig_account_id: igAccountId, job_id: jobId, notification: "skipped_no_token" });
      return jsonResponse({ action: "skipped", reason: "no_push_token" });
    }

    // Cooldown: don't send more than one notification per 12h
    if (profile.last_notification_sent_at) {
      const elapsed = Date.now() - new Date(profile.last_notification_sent_at).getTime();
      if (elapsed < NOTIFICATION_COOLDOWN_MS) {
        const hoursRemaining = Math.ceil((NOTIFICATION_COOLDOWN_MS - elapsed) / (60 * 60 * 1_000));
        const skipReason = `notification_cooldown (${hoursRemaining}h remaining)`;
        await markSkipped(db, diffId, skipReason);
        await logEvent(db, userId, "auto_snapshot_completed", { ig_account_id: igAccountId, job_id: jobId, notification: "skipped_cooldown", hours_remaining: hoursRemaining });
        return jsonResponse({ action: "skipped", reason: "notification_cooldown", hours_remaining: hoursRemaining });
      }
    }

    // ── 5. Compute change metrics ───────────────────────────────
    const netChange    = diff.net_follower_change ?? 0;
    const absNetChange = Math.abs(netChange);
    const lostCount    = Array.isArray(diff.lost_followers) ? diff.lost_followers.length : 0;
    const gainedCount  = Array.isArray(diff.new_followers)  ? diff.new_followers.length  : 0;

    // ── 6. Detect new content ───────────────────────────────────
    // Compare post_count between current and previous snapshot
    let hasNewContent = false;
    if (diff.from_snapshot_id && diff.to_snapshot_id) {
      const { data: snapshots } = await db
        .from("follower_snapshots")
        .select("id, post_count")
        .in("id", [diff.from_snapshot_id, diff.to_snapshot_id]);

      if (snapshots && snapshots.length === 2) {
        const prev = snapshots.find((s: { id: string }) => s.id === diff.from_snapshot_id);
        const curr = snapshots.find((s: { id: string }) => s.id === diff.to_snapshot_id);
        if (prev?.post_count != null && curr?.post_count != null) {
          hasNewContent = curr.post_count > prev.post_count;
        }
      }
    }

    // ── 7. Apply threshold logic ────────────────────────────────
    let shouldNotify = false;
    let reason = "";

    if (hasNewContent && netChange !== 0) {
      // Lower threshold: any change after posting content
      shouldNotify = true;
      reason = netChange < 0
        ? "unfollows_after_post"
        : "followers_after_post";
    } else if (absNetChange >= NET_FOLLOWER_THRESHOLD) {
      shouldNotify = true;
      reason = `net_followers_gte_${NET_FOLLOWER_THRESHOLD}`;
    } else if (lostCount >= UNFOLLOWER_THRESHOLD) {
      shouldNotify = true;
      reason = `unfollowers_gte_${UNFOLLOWER_THRESHOLD}`;
    }

    if (!shouldNotify) {
      const skipReason = `below_threshold (net=${netChange}, lost=${lostCount}, new_content=${hasNewContent})`;
      await markSkipped(db, diffId, skipReason);
      await logEvent(db, userId, "auto_snapshot_completed", {
        ig_account_id: igAccountId,
        job_id: jobId,
        notification: "skipped_below_threshold",
        net_change: netChange,
        lost_count: lostCount,
        has_new_content: hasNewContent,
      });
      return jsonResponse({ action: "skipped", reason: "below_threshold", net_change: netChange, lost_count: lostCount });
    }

    // ── 8. Build notification copy ──────────────────────────────
    const { title, notifBody } = buildNotificationCopy({
      hasNewContent,
      netChange,
      lostCount,
      gainedCount,
    });

    // ── 9. Send push notification ───────────────────────────────
    const ticket = await sendPushNotification(
      profile.push_token,
      title,
      notifBody,
      { screen: "dashboard", source: "auto_snapshot", jobId, igAccountId },
    );

    // ── 10. Update audit trail ──────────────────────────────────
    await db.from("diffs").update({
      notification_sent:           true,
      notification_reason:         reason,
      notification_skipped_reason: null,
    }).eq("id", diffId);

    // Update per-user notification cooldown timestamp
    await db.from("profiles").update({
      last_notification_sent_at: new Date().toISOString(),
    }).eq("id", userId);

    // Analytics events
    await logEvent(db, userId, "meaningful_change_detected", {
      ig_account_id: igAccountId,
      diff_id:       diffId,
      reason,
      net_change:    netChange,
      lost_count:    lostCount,
      has_new_content: hasNewContent,
    });

    await logEvent(db, userId, "notification_sent", {
      ig_account_id: igAccountId,
      diff_id:       diffId,
      reason,
      title,
      body: notifBody,
      push_ok: ticket.ok,
    });

    console.log(`[smart-notify] Sent notification for diff ${diffId}: ${reason} (net=${netChange}, lost=${lostCount}, content=${hasNewContent})`);
    return jsonResponse({
      action:   "sent",
      reason,
      title,
      body:     notifBody,
      push_ok:  ticket.ok,
    });

  } catch (err) {
    console.error("[smart-notify] Error:", (err as Error).message);
    return jsonResponse({ error: (err as Error).message }, 500);
  }
});

// ── Helpers ────────────────────────────────────────────────────

function buildNotificationCopy(params: {
  hasNewContent: boolean;
  netChange: number;
  lostCount: number;
  gainedCount: number;
}): { title: string; notifBody: string } {
  const { hasNewContent, netChange, lostCount, gainedCount } = params;

  if (hasNewContent) {
    // Content-aware copy: lead with the fact that they posted
    if (lostCount > 0 && netChange < 0) {
      return {
        title: "Activity after your latest post",
        notifBody: `${lostCount} new unfollow${lostCount !== 1 ? "s" : ""} showed up after your recent post.`,
      };
    }
    if (netChange > 0) {
      return {
        title: "Your audience grew after your post",
        notifBody: `You gained ${gainedCount} follower${gainedCount !== 1 ? "s" : ""} since your latest post.`,
      };
    }
    return {
      title: "Activity after your latest post",
      notifBody: "Your audience changed after your latest post. Tap to see details.",
    };
  }

  // Standard follower-change copy
  if (lostCount > 0 && netChange < 0) {
    return {
      title: "Follower update",
      notifBody: `${lostCount} ${lostCount === 1 ? "person" : "people"} unfollowed you today.`,
    };
  }
  if (gainedCount > 0 && netChange > 0) {
    return {
      title: "Follower update",
      notifBody: `You gained ${gainedCount} follower${gainedCount !== 1 ? "s" : ""} since yesterday.`,
    };
  }
  return {
    title: "Follower update",
    notifBody: "Your follower count changed again today. Tap to see details.",
  };
}

// deno-lint-ignore no-explicit-any
async function markSkipped(db: any, diffId: string, reason: string): Promise<void> {
  await db.from("diffs").update({
    notification_sent:           false,
    notification_skipped_reason: reason,
  }).eq("id", diffId);
}

// deno-lint-ignore no-explicit-any
async function logEvent(db: any, userId: string, event: string, payload: Record<string, unknown>): Promise<void> {
  await db.from("funnel_events").insert({
    user_id:    userId,
    event_name: event,
    payload,
  }).catch(() => {});
}
