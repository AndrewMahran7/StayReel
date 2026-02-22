// _shared/diff.ts
//
// Pure, side-effect-free snapshot diff computation.
// All exported functions are deterministic given the same inputs.
//
// TERMINOLOGY
// ───────────
//   follower  — someone who follows the tracked account
//   following — someone the tracked account follows
//
// INPUTS  (both previous and current lists are required for every set)
// ──────────────────────────────────────────────────────────────────────
//   prevFollowers   list of people who followed you at snapshot N-1
//   currFollowers   list of people who follow you  at snapshot N
//   prevFollowing   list of people you followed    at snapshot N-1
//   currFollowing   list of people you follow      at snapshot N
//
// OUTPUTS
// ───────
//   new_followers        in currFollowers  ∖ prevFollowers
//   lost_followers       in prevFollowers  ∖ currFollowers      (they unfollowed you)
//   you_unfollowed       in prevFollowing  ∖ currFollowing      (you unfollowed them)
//   you_newly_followed   in currFollowing  ∖ prevFollowing      (you started following them)
//   not_following_back   in currFollowing  ∖ currFollowers      (you follow them, they don't follow you)
//   you_dont_follow_back in currFollowers  ∖ currFollowing      (they follow you, you don't follow them)
//   net_follower_change  signed integer (positive = growth)
//   net_following_change signed integer
//
// NOTE ON COUNT vs LIST LENGTH
// ────────────────────────────
// When the follower list was truncated (is_list_complete = false) the
// api_count fields from the Instagram profile endpoint are more accurate
// than list.length for net_*_change.  Pass them explicitly; they default
// to the list lengths when omitted.

export interface IgEdge {
  ig_id: string;    // numeric Instagram ID, may be "" when unavailable
  username: string; // lower-case handle (no "@")
}

// ── Snapshot pair input ────────────────────────────────────────

export interface SnapshotPair {
  prevFollowers: IgEdge[];
  currFollowers: IgEdge[];
  prevFollowing: IgEdge[];
  currFollowing: IgEdge[];
  /**
   * Authoritative counts from the IG profile API.
   * Used only for net_*_change when the lists are incomplete.
   * Defaults to the list lengths when not provided.
   */
  prevFollowerCountApi?: number;
  currFollowerCountApi?: number;
  prevFollowingCountApi?: number;
  currFollowingCountApi?: number;
}

// ── Diff output ────────────────────────────────────────────────

export interface SnapshotDiff {
  // ── Follower changes ────────────────────────────────────────
  /** People who started following you between snapshots. */
  new_followers: IgEdge[];
  /** People who stopped following you between snapshots. */
  lost_followers: IgEdge[];

  // ── Following changes (your actions) ────────────────────────
  /** Accounts you were following before but you unfollowed. */
  you_unfollowed: IgEdge[];
  /** Accounts you started following in this period. */
  you_newly_followed: IgEdge[];

  // ── Reciprocity — point-in-time state at currSnapshot ───────
  /** Accounts you follow that do NOT follow you back (as of current snapshot). */
  not_following_back: IgEdge[];
  /** Accounts that follow you but you do NOT follow them back (as of current snapshot). */
  you_dont_follow_back: IgEdge[];

  // ── Net deltas ───────────────────────────────────────────────
  net_follower_change: number;
  net_following_change: number;

  // ── Quality flag ─────────────────────────────────────────────
  /**
   * true  — all inputs were fully paginated; all sets are exact.
   * false — at least one list was truncated; sets may be incomplete.
   */
  is_complete: boolean;
}

// ── Lookup key strategy ────────────────────────────────────────
// Primary key: ig_id (stable numeric ID).
// Fallback key: username (changes are rare but possible).
// We use ig_id when both edges have one; fall back to username otherwise.
// This avoids treating a username-change as an unfollow + re-follow.

function edgeKey(e: IgEdge): string {
  return e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`;
}

function toMap(edges: IgEdge[]): Map<string, IgEdge> {
  const m = new Map<string, IgEdge>();
  for (const e of edges) {
    const k = edgeKey(e);
    if (k) m.set(k, e);
  }
  return m;
}

// Set difference: elements in `a` that are NOT in `b` (by edgeKey).
function setDiff(a: IgEdge[], bMap: Map<string, IgEdge>): IgEdge[] {
  return a.filter((e) => !bMap.has(edgeKey(e)));
}

// Set intersection: elements in `a` that ARE in `b` (by edgeKey).
// Returns the `a`-side edge (preserves ig_id/username from `a`).
function setIntersect(a: IgEdge[], bMap: Map<string, IgEdge>): IgEdge[] {
  return a.filter((e) => bMap.has(edgeKey(e)));
}

// ── Pure diff function ─────────────────────────────────────────

/**
 * Computes the full diff between two consecutive follower snapshots.
 * Pure function — no side effects, no DB calls.
 */
export function computeSnapshotDiff(
  input: SnapshotPair,
  isComplete = true,
): SnapshotDiff {
  const {
    prevFollowers,
    currFollowers,
    prevFollowing,
    currFollowing,
    prevFollowerCountApi,
    currFollowerCountApi,
    prevFollowingCountApi,
    currFollowingCountApi,
  } = input;

  // Build lookup maps once
  const prevFollowersMap  = toMap(prevFollowers);
  const currFollowersMap  = toMap(currFollowers);
  const prevFollowingMap  = toMap(prevFollowing);
  const currFollowingMap  = toMap(currFollowing);

  // ── Follower changes ────────────────────────────────────────
  const new_followers  = setDiff(currFollowers, prevFollowersMap);
  const lost_followers = setDiff(prevFollowers, currFollowersMap);

  // ── Following changes (your own actions) ────────────────────
  const you_unfollowed     = setDiff(prevFollowing, currFollowingMap);
  const you_newly_followed = setDiff(currFollowing, prevFollowingMap);

  // ── Reciprocity at current snapshot ─────────────────────────
  const not_following_back   = setDiff(currFollowing, currFollowersMap);
  const you_dont_follow_back = setDiff(currFollowers, currFollowingMap);

  // ── Net changes (prefer API counts for accuracy) ─────────────
  const prevFC = prevFollowerCountApi  ?? prevFollowers.length;
  const currFC = currFollowerCountApi  ?? currFollowers.length;
  const prevFG = prevFollowingCountApi ?? prevFollowing.length;
  const currFG = currFollowingCountApi ?? currFollowing.length;

  return {
    new_followers,
    lost_followers,
    you_unfollowed,
    you_newly_followed,
    not_following_back,
    you_dont_follow_back,
    net_follower_change:  currFC - prevFC,
    net_following_change: currFG - prevFG,
    is_complete:          isComplete,
  };
}

// ── Convenience: diff summary counts ──────────────────────────

export interface DiffSummary {
  new_followers_count:        number;
  lost_followers_count:       number;
  you_unfollowed_count:       number;
  you_newly_followed_count:   number;
  not_following_back_count:   number;
  you_dont_follow_back_count: number;
  net_follower_change:        number;
  net_following_change:       number;
  is_complete:                boolean;
}

export function summariseDiff(d: SnapshotDiff): DiffSummary {
  return {
    new_followers_count:        d.new_followers.length,
    lost_followers_count:       d.lost_followers.length,
    you_unfollowed_count:       d.you_unfollowed.length,
    you_newly_followed_count:   d.you_newly_followed.length,
    not_following_back_count:   d.not_following_back.length,
    you_dont_follow_back_count: d.you_dont_follow_back.length,
    net_follower_change:        d.net_follower_change,
    net_following_change:       d.net_following_change,
    is_complete:                d.is_complete,
  };
}
