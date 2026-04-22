/// <reference path="../deno-types.d.ts" />
// _shared/snapshotProgress.ts
//
// Progress calculation for the server-owned snapshot lifecycle.
//
// Two modes:
//   exact  — derived from completed_work_units / total_work_units.
//   staged — phase-bucket fallback when targets are unknown.
//
// Invariants (enforced here, not at the DB):
//   • progress_percent never decreases.
//   • progress_percent is capped at 99 until status === 'complete'.
//   • progress_stage tracks the active phase plus terminal states.

import type { SnapshotJobRow } from "./snapshotJob.ts";

export type ProgressStage =
  | "started"
  | "followers"
  | "following"
  | "finalize"
  | "complete"
  | "failed"
  | "reconnect_required";

export type ProgressMode = "exact" | "staged";

export interface ProgressSnapshot {
  percent: number;            // 0–100, monotonic non-decreasing
  stage:   ProgressStage;
  mode:    ProgressMode;
  completedWorkUnits: number;
  totalWorkUnits:     number;
}

// Staged buckets — used whenever targets are unavailable.
const STAGED_BUCKETS: Record<ProgressStage, [number, number]> = {
  started:              [0, 5],
  followers:            [5, 70],
  following:            [70, 90],
  finalize:             [90, 99],
  complete:             [100, 100],
  failed:               [0, 0],          // unused — failed retains last percent
  reconnect_required:   [0, 0],          // unused — same as failed
};

/**
 * Compute the next progress snapshot from the current job row plus the
 * latest counts observed in this chunk. Pure function — no DB writes.
 */
export function computeProgress(
  job: SnapshotJobRow,
  observed: {
    phase:          "followers" | "following" | "finalize";
    followersDone:  number;
    followingDone:  number;
    /** Final/complete states are signalled by the caller, not derived here. */
    terminal?:      "complete" | "failed" | "reconnect_required";
  },
): ProgressSnapshot {
  // Terminal states short-circuit.
  if (observed.terminal === "complete") {
    return {
      percent: 100,
      stage:   "complete",
      mode:    job.progress_mode as ProgressMode,
      completedWorkUnits: job.total_work_units || 0,
      totalWorkUnits:     job.total_work_units || 0,
    };
  }

  if (observed.terminal === "failed" || observed.terminal === "reconnect_required") {
    return {
      percent: job.progress_percent ?? 0,            // freeze at last value
      stage:   observed.terminal,
      mode:    (job.progress_mode as ProgressMode) ?? "staged",
      completedWorkUnits: job.completed_work_units ?? 0,
      totalWorkUnits:     job.total_work_units ?? 0,
    };
  }

  // ── Choose mode ────────────────────────────────────────────────────
  const followersTarget = job.followers_target_count ?? 0;
  const followingTarget = job.following_cached ? 0 : (job.following_target_count ?? 0);
  const totalTarget     = followersTarget + followingTarget;

  let percent: number;
  let mode: ProgressMode;
  let completedWorkUnits = 0;
  let totalWorkUnits     = totalTarget;

  if (totalTarget > 0) {
    mode = "exact";
    completedWorkUnits = Math.min(observed.followersDone + observed.followingDone, totalTarget);
    const exact = Math.floor((completedWorkUnits / totalTarget) * 100);
    // Reserve the final 10% for the finalize phase so the bar always
    // shows progress when finalize starts.
    percent = observed.phase === "finalize"
      ? Math.max(exact, 90)
      : Math.min(exact, 89);
  } else {
    mode = "staged";
    const [lo, hi] = STAGED_BUCKETS[observed.phase];
    // Within a phase bucket, slowly advance toward the upper bound based
    // on per-phase target hint when available, else split evenly.
    const phaseTarget = observed.phase === "followers" ? followersTarget : followingTarget;
    const phaseDone   = observed.phase === "followers" ? observed.followersDone : observed.followingDone;
    if (phaseTarget > 0) {
      const ratio = Math.min(phaseDone / phaseTarget, 1);
      percent = Math.floor(lo + (hi - lo) * ratio);
    } else {
      percent = lo;
    }
  }

  // Cap at 99 until terminal complete.
  percent = Math.min(percent, 99);

  // Monotonic non-decreasing.
  const prev = job.progress_percent ?? 0;
  if (percent < prev) percent = prev;

  return {
    percent,
    stage: observed.phase,
    mode,
    completedWorkUnits,
    totalWorkUnits,
  };
}

/**
 * Persist a computed progress snapshot. Atomic UPDATE — never lowers
 * progress_percent (defensive against out-of-order chunk completion).
 */
// deno-lint-ignore no-explicit-any
export async function persistProgress(db: any, jobId: string, snap: ProgressSnapshot): Promise<void> {
  const now = new Date().toISOString();
  await db.from("snapshot_jobs")
    .update({
      progress_percent:       snap.percent,
      progress_stage:         snap.stage,
      progress_mode:          snap.mode,
      completed_work_units:   snap.completedWorkUnits,
      total_work_units:       snap.totalWorkUnits,
      last_chunk_completed_at: now,
      updated_at:             now,
    })
    .eq("id", jobId)
    .lte("progress_percent", snap.percent); // never decrease
}

/**
 * Initialise progress targets at job creation. Safe to call once per job.
 */
// deno-lint-ignore no-explicit-any
export async function initialiseProgressTargets(
  db: any,
  jobId: string,
  followersTarget: number,
  followingTarget: number,
  followingCached: boolean,
): Promise<void> {
  const total = followersTarget + (followingCached ? 0 : followingTarget);
  await db.from("snapshot_jobs")
    .update({
      followers_target_count: followersTarget,
      following_target_count: followingTarget,
      following_cached:       followingCached,
      total_work_units:       total,
      progress_mode:          total > 0 ? "exact" : "staged",
      progress_stage:         "started",
      progress_percent:       0,
      updated_at:             new Date().toISOString(),
    })
    .eq("id", jobId);
}
