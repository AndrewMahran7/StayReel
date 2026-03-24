/// <reference path="../deno-types.d.ts" />
// weekly-summary-notify/index.ts
//
// Scheduled Edge Function — intended to be called weekly by a cron trigger
// (Supabase pg_cron, GitHub Actions, or any external scheduler).
//
// For each user who:
//   1. Has a push_token
//   2. Has notify_weekly_summary = true
//   3. Has at least one snapshot in the past 7 days
//
// … sends a personalised push notification summarising their follower movement.
//
// POST /weekly-summary-notify
// Auth: service-role key (not user-scoped — this is a backend job)

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";
import { sendPushNotifications, PushMessage }  from "../_shared/push.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();

  // Only allow service-role or a shared cron secret
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";

  const token = authHeader.replace("Bearer ", "");
  if (token !== serviceKey && token !== cronSecret) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const db = adminClient();

  // ── 1. Find eligible users ──────────────────────────────────
  // Join profiles (push_token) + user_settings (notify pref) + ig_accounts
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: accounts, error: acctErr } = await db
    .from("ig_accounts")
    .select(`
      id,
      user_id,
      last_snapshot_at,
      profiles!inner ( push_token ),
      user_settings!inner ( notify_weekly_summary, notify_on_unfollow )
    `)
    .eq("status", "active")
    .is("deleted_at", null)
    .gte("last_snapshot_at", oneWeekAgo);

  if (acctErr) {
    console.error("[weekly-summary] Account query error:", acctErr.message);
    return jsonResponse({ error: acctErr.message }, 500);
  }

  if (!accounts || accounts.length === 0) {
    console.log("[weekly-summary] No eligible accounts.");
    return jsonResponse({ sent: 0, skipped: 0, message: "No eligible accounts" });
  }

  // ── 2. For each account, compute weekly stats ───────────────
  const messages: PushMessage[] = [];
  let skipped = 0;

  for (const acct of accounts) {
    // Type narrowing for joined data
    const profile  = acct.profiles  as unknown as { push_token: string | null };
    const settings = acct.user_settings as unknown as {
      notify_weekly_summary: boolean;
      notify_on_unfollow: boolean;
    };

    if (!profile?.push_token || !settings?.notify_weekly_summary) {
      skipped++;
      continue;
    }

    // Get diffs from the past 7 days for this account
    const { data: diffs } = await db
      .from("diffs")
      .select("net_follower_change, net_following_change, lost_followers, new_followers")
      .eq("ig_account_id", acct.id)
      .gte("to_captured_at", oneWeekAgo)
      .order("to_captured_at", { ascending: false });

    if (!diffs || diffs.length === 0) {
      skipped++;
      continue;
    }

    // Aggregate weekly stats
    let totalNetFollowers  = 0;
    let totalNewFollowers  = 0;
    let totalLostFollowers = 0;

    for (const d of diffs) {
      totalNetFollowers  += d.net_follower_change ?? 0;
      totalNewFollowers  += Array.isArray(d.new_followers) ? d.new_followers.length : 0;
      totalLostFollowers += Array.isArray(d.lost_followers) ? d.lost_followers.length : 0;
    }

    // Build notification body
    let body: string;

    if (totalNewFollowers === 0 && totalLostFollowers === 0) {
      body = "No follower changes between your snapshots this week. Steady! \u2728";
    } else {
      const parts: string[] = [];

      if (totalNewFollowers > 0) {
        parts.push(`+${totalNewFollowers} new follower${totalNewFollowers !== 1 ? "s" : ""}`);
      }
      if (totalLostFollowers > 0 && settings.notify_on_unfollow) {
        parts.push(`${totalLostFollowers} unfollow${totalLostFollowers !== 1 ? "s" : ""}`);
      }

      if (totalNetFollowers > 0) {
        body = `This week: ${parts.join(", ")}. You\u2019re growing! \uD83D\uDCC8`;
      } else if (totalNetFollowers < 0) {
        body = `This week: ${parts.join(", ")}. Tap to see details.`;
      } else {
        body = `This week: ${parts.join(", ")}. Net change: 0. Steady! \uD83D\uDCAA`;
      }
    }

    messages.push({
      to:        profile.push_token,
      title:     "Your Weekly Follower Summary",
      body,
      data:      { screen: "dashboard" },
      sound:     "default",
      channelId: "default",
    });
  }

  // ── 3. Send all notifications ───────────────────────────────
  const tickets = await sendPushNotifications(messages);
  const sent   = tickets.filter((t) => t.ok).length;
  const failed = tickets.filter((t) => !t.ok).length;

  console.log(`[weekly-summary] Sent: ${sent}, Failed: ${failed}, Skipped: ${skipped}`);

  return jsonResponse({
    sent,
    failed,
    skipped,
    total: accounts.length,
  });
});
