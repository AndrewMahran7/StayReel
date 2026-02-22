// _shared/diff_writer.ts
//
// Persists a SnapshotDiff to the public.diffs table via the
// service-role client (bypasses RLS — ownership was already
// verified by the calling Edge Function).
//
// Responsibilities:
//   • Upsert the diff row (idempotent on the snapshot pair UNIQUE key).
//   • Resolve ig_account_id from the snapshot row if not supplied.
//   • Return the inserted/updated diff row id.
//   • Never throw — returns a DiffWriteResult with ok: false on error.

import { adminClient } from "./supabase_client.ts";
import { SnapshotDiff, IgEdge } from "./diff.ts";

// ── Input ──────────────────────────────────────────────────────

export interface DiffWriteInput {
  igAccountId: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  fromCapturedAt: string;  // ISO-8601
  toCapturedAt: string;    // ISO-8601
  diff: SnapshotDiff;
}

// ── Output ─────────────────────────────────────────────────────

export type DiffWriteResult =
  | { ok: true; diffId: string }
  | { ok: false; error: string };

// ── Writer ─────────────────────────────────────────────────────

/**
 * Upserts a diff row in public.diffs.
 *
 * Uses ON CONFLICT (from_snapshot_id, to_snapshot_id) DO UPDATE so
 * re-running capture-snapshot for the same snapshot pair is safe.
 *
 * Returns { ok: true, diffId } on success, { ok: false, error } on failure.
 */
export async function writeDiff(
  input: DiffWriteInput,
): Promise<DiffWriteResult> {
  const { igAccountId, fromSnapshotId, toSnapshotId, fromCapturedAt, toCapturedAt, diff } =
    input;

  const row = {
    ig_account_id:        igAccountId,
    from_snapshot_id:     fromSnapshotId,
    to_snapshot_id:       toSnapshotId,
    from_captured_at:     fromCapturedAt,
    to_captured_at:       toCapturedAt,
    // counts
    net_follower_change:  diff.net_follower_change,
    net_following_change: diff.net_following_change,
    // follower sets
    new_followers:        diff.new_followers         satisfies IgEdge[],
    lost_followers:       diff.lost_followers        satisfies IgEdge[],
    // following sets (your actions)
    you_unfollowed:       diff.you_unfollowed        satisfies IgEdge[],
    you_newly_followed:   diff.you_newly_followed    satisfies IgEdge[],
    // reciprocity
    not_following_back:   diff.not_following_back    satisfies IgEdge[],
    you_dont_follow_back: diff.you_dont_follow_back  satisfies IgEdge[],
    // quality
    is_complete:          diff.is_complete,
    computed_at:          new Date().toISOString(),
  };

  const { data, error } = await adminClient()
    .from("diffs")
    .upsert(row, {
      onConflict: "from_snapshot_id,to_snapshot_id",
      ignoreDuplicates: false, // always overwrite on re-run
    })
    .select("id")
    .single();

  if (error || !data) {
    const msg = error?.message ?? "empty response from upsert";
    console.error("[diff_writer] upsert failed:", msg);
    return { ok: false, error: msg };
  }

  return { ok: true, diffId: data.id as string };
}

// ── Previous snapshot loader ───────────────────────────────────
// Convenience helper used by capture-snapshot to load the prior
// snapshot's lists without duplicating the query everywhere.

export interface PreviousSnapshot {
  id: string;
  capturedAt: string;
  followerCount: number;
  followingCount: number;
  followerList: IgEdge[];
  followingList: IgEdge[];
}

/**
 * Loads the most recent snapshot for igAccountId that precedes
 * excludeSnapshotId.  Returns null when no prior snapshot exists
 * (first-ever capture).
 *
 * follower_list and following_list are read from the JSONB columns;
 * falls back to [] when the list has already been pruned (> 30 days).
 */
export async function loadPreviousSnapshot(
  igAccountId: string,
  excludeSnapshotId: string,
): Promise<PreviousSnapshot | null> {
  const { data, error } = await adminClient()
    .from("follower_snapshots")
    .select(
      "id, captured_at, follower_count, following_count, " +
        "followers_json, following_json",
    )
    .eq("ig_account_id", igAccountId)
    .neq("id", excludeSnapshotId)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[diff_writer] loadPreviousSnapshot error:", error.message);
    return null;
  }
  if (!data) return null;

  // Cast away GenericStringError – client has no generated DB schema types
  const row = data as unknown as {
    id: string; captured_at: string; follower_count: number;
    following_count: number; followers_json: unknown; following_json: unknown;
  };

  return {
    id: row.id,
    capturedAt: row.captured_at,
    followerCount: row.follower_count,
    followingCount: row.following_count,
    followerList: Array.isArray(row.followers_json)
      ? (row.followers_json as IgEdge[])
      : [],
    followingList: Array.isArray(row.following_json)
      ? (row.following_json as IgEdge[])
      : [],
  };
}
