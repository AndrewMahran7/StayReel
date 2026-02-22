/// <reference path="../deno-types.d.ts" />
// diffs-latest/index.ts
//
// GET /diffs-latest?ig_account_id=<uuid>
//
// Returns comprehensive dashboard data:
//   â€¢ Reciprocity metrics â€” always computed fresh from latest snapshot JSON
//   â€¢ Change metrics     â€” from stored diff, only when is_complete=true
//   â€¢ Account stats      â€” follower/following/mutual counts from latest snapshot
//   â€¢ Weekly summary     â€” totals from all diffs in the past 7 days
//   â€¢ Streak             â€” from ig_accounts columns
//   â€¢ next_snapshot_allowed_at â€” computed from last_snapshot_at + 24h

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors } from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";

const DAILY_LIMIT_MS = 24 * 60 * 60 * 1_000;

interface IgEdge { ig_id: string; username: string; }

function edgeKey(e: IgEdge): string {
  return e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`;
}
function toMap(edges: IgEdge[]): Map<string, IgEdge> {
  const m = new Map<string, IgEdge>();
  for (const e of edges) { const k = edgeKey(e); if (k) m.set(k, e); }
  return m;
}
function setDiff(a: IgEdge[], bMap: Map<string, IgEdge>): number {
  return a.filter(e => !bMap.has(edgeKey(e))).length;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireAuth(req);
    const url = new URL(req.url);
    const igAccountId = url.searchParams.get("ig_account_id");
    if (!igAccountId) throw Errors.badRequest("ig_account_id is required.");
    await requireOwnsAccount(caller.authHeader, igAccountId);

    // â”€â”€ Fetch ig_accounts row for streak + last_snapshot_at â”€â”€
    const { data: acct } = await adminClient()
      .from("ig_accounts")
      .select("last_snapshot_at, current_streak_days, longest_streak_days")
      .eq("id", igAccountId)
      .maybeSingle();

    // â”€â”€ Fetch latest snapshot for reciprocity + counts â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: snap } = await adminClient()
      .from("follower_snapshots")
      .select("id, captured_at, follower_count, following_count, mutual_count, followers_json, following_json, is_list_complete")
      .eq("ig_account_id", igAccountId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!snap) {
      return jsonResponse({ no_data: true }, 404);
    }

    // Reciprocity: always computed from raw JSON
    const followers: IgEdge[] = Array.isArray(snap.followers_json) ? snap.followers_json as IgEdge[] : [];
    const following: IgEdge[] = Array.isArray(snap.following_json) ? snap.following_json  as IgEdge[] : [];
    const followersMap = toMap(followers);
    const followingMap = toMap(following);
    const not_following_back_count   = setDiff(following, followersMap);
    const you_dont_follow_back_count = setDiff(followers, followingMap);

    // Mutual count: prefer stored value, fallback to intersection computation
    const mutual_count = snap.mutual_count != null
      ? snap.mutual_count
      : following.filter(e => followersMap.has(edgeKey(e))).length;

    // â”€â”€ next_snapshot_allowed_at â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let next_snapshot_allowed_at: string | null = null;
    if (acct?.last_snapshot_at) {
      const lastMs = new Date(acct.last_snapshot_at).getTime();
      const nextMs = lastMs + DAILY_LIMIT_MS;
      if (nextMs > Date.now()) {
        next_snapshot_allowed_at = new Date(nextMs).toISOString();
      }
    }

    // â”€â”€ Latest complete diff for change metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { data: diffs } = await adminClient()
      .from("diffs")
      .select(
        "id, from_snapshot_id, to_snapshot_id, from_captured_at, to_captured_at, " +
        "net_follower_change, net_following_change, " +
        "new_followers, lost_followers, you_unfollowed, you_newly_followed, is_complete"
      )
      .eq("ig_account_id", igAccountId)
      .order("to_captured_at", { ascending: false })
      .limit(1);

    const d = diffs?.[0];
    const diffUsable = d != null && d.is_complete === true;

    const nf  = diffUsable && Array.isArray(d.new_followers)      ? d.new_followers.length      : 0;
    const lf  = diffUsable && Array.isArray(d.lost_followers)     ? d.lost_followers.length     : 0;
    const yu  = diffUsable && Array.isArray(d.you_unfollowed)     ? d.you_unfollowed.length     : 0;
    const ynf = diffUsable && Array.isArray(d.you_newly_followed) ? d.you_newly_followed.length : 0;

    // â”€â”€ Weekly summary: all complete diffs from last 7 days â”€â”€â”€
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const { data: weeklyDiffs } = await adminClient()
      .from("diffs")
      .select("new_followers, lost_followers, net_follower_change, is_complete")
      .eq("ig_account_id", igAccountId)
      .eq("is_complete", true)
      .gte("to_captured_at", sevenDaysAgo)
      .order("to_captured_at", { ascending: false });

    let weekly_new_followers  = 0;
    let weekly_lost_followers = 0;
    for (const wd of (weeklyDiffs ?? [])) {
      weekly_new_followers  += Array.isArray(wd.new_followers)   ? wd.new_followers.length  : 0;
      weekly_lost_followers += Array.isArray(wd.lost_followers)  ? wd.lost_followers.length : 0;
    }
    const weekly_net_change        = weekly_new_followers - weekly_lost_followers;
    const has_weekly_summary       = (weeklyDiffs?.length ?? 0) >= 2;

    return jsonResponse({
      // Diff identification
      diff_id:                    diffUsable ? d.id               : null,
      from_snapshot_id:           diffUsable ? d.from_snapshot_id : null,
      to_snapshot_id:             snap.id,
      from_captured_at:           diffUsable ? d.from_captured_at : null,
      to_captured_at:             snap.captured_at,

      // Change metrics (complete diffs only)
      net_follower_change:        diffUsable ? (d.net_follower_change  ?? 0) : 0,
      net_following_change:       diffUsable ? (d.net_following_change ?? 0) : 0,
      new_followers_count:        nf,
      lost_followers_count:       lf,
      you_unfollowed_count:       yu,
      you_newly_followed_count:   ynf,

      // Reciprocity (always live from latest snapshot)
      not_following_back_count,
      you_dont_follow_back_count,

      // Account stats
      follower_count:             snap.follower_count  ?? 0,
      following_count:            snap.following_count ?? 0,
      mutual_count,

      // Weekly summary
      weekly_new_followers,
      weekly_lost_followers,
      weekly_net_change,
      has_weekly_summary,

      // Streak
      current_streak_days:        acct?.current_streak_days ?? 0,
      longest_streak_days:        acct?.longest_streak_days ?? 0,

      // Rate limit
      next_snapshot_allowed_at,

      // Flags
      is_complete:                snap.is_list_complete ?? false,
      has_diff:                   diffUsable,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
