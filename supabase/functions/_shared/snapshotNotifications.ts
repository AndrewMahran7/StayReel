/// <reference path="../deno-types.d.ts" />
// _shared/snapshotNotifications.ts
//
// Milestone-based push notifications for the server-owned snapshot lifecycle.
//
// Idempotency:
//   • snapshot_jobs.notification_mask is a bitmask of milestones already
//     delivered for this job.
//   • claimMilestone() performs an atomic UPDATE that ORs the bit only if
//     it is currently unset, returning the row only when the caller wins
//     the race. Workers that lose the race do not send a push.
//
// Quiet:
//   • Never throws — push failures are logged and swallowed.
//   • Respects user_settings.notify_refresh_complete for completion push,
//     and notify_on_token_expiry for reconnect_required push.
//   • Progress-only milestones (25/50/75/almost_done) are always sent,
//     since the user opted in by tapping "Take Snapshot".

import { sendPushNotification } from "./push.ts";

export const MILESTONE_BITS = {
  STARTED:             1 << 0, //   1
  P25:                 1 << 1, //   2
  P50:                 1 << 2, //   4
  P75:                 1 << 3, //   8
  ALMOST_DONE:         1 << 4, //  16
  COMPLETE:            1 << 5, //  32
  FAILED:              1 << 6, //  64
  RECONNECT_REQUIRED:  1 << 7, // 128
} as const;

export type MilestoneName = keyof typeof MILESTONE_BITS;

interface NotificationSpec {
  title: string;
  body:  string;
}

const SPECS: Record<MilestoneName, NotificationSpec> = {
  STARTED: {
    title: "Snapshot started",
    body:  "We're scanning your followers in the background. We'll ping you when it's done.",
  },
  P25: {
    title: "Snapshot 25%",
    body:  "Quarter of the way through your follower scan.",
  },
  P50: {
    title: "Snapshot halfway",
    body:  "Halfway through scanning your followers.",
  },
  P75: {
    title: "Snapshot 75%",
    body:  "Almost there — 75% of your follower scan complete.",
  },
  ALMOST_DONE: {
    title: "Snapshot almost done",
    body:  "Wrapping up your snapshot now.",
  },
  COMPLETE: {
    title: "Snapshot ready \uD83D\uDCF8",
    body:  "Your latest snapshot is ready. Tap to see your results.",
  },
  FAILED: {
    title: "Snapshot couldn't finish",
    body:  "We hit a snag finishing your snapshot. Open StayReel for details.",
  },
  RECONNECT_REQUIRED: {
    title: "Reconnect Instagram",
    body:  "StayReel is paused until you reconnect Instagram. Tap to reconnect.",
  },
};

/**
 * Atomically claim a milestone for this job. Returns true if the caller
 * is the first to claim it (and should send the push), false otherwise.
 */
// deno-lint-ignore no-explicit-any
export async function claimMilestone(
  db: any,
  jobId: string,
  milestone: MilestoneName,
): Promise<boolean> {
  const bit = MILESTONE_BITS[milestone];

  // Postgres bitwise update with WHERE guard.
  // Supabase JS client doesn't support raw bit ops in `.update()`, so we use rpc-style
  // via the .filter() + manual SQL through .rpc('set_milestone_bit', …) — but to avoid
  // adding an RPC, we do an optimistic read-modify-write that's safe under our lock model:
  // a job can only have one worker holding its lock at any time, so contention here is
  // limited to the (rare) case where the fallback scheduler races a self-trigger. The
  // .eq("notification_mask", currentMask) clause turns this into a CAS.
  const { data: row } = await db
    .from("snapshot_jobs")
    .select("notification_mask")
    .eq("id", jobId)
    .maybeSingle();

  if (!row) return false;
  const currentMask: number = row.notification_mask ?? 0;
  if ((currentMask & bit) !== 0) return false; // already sent

  const { data: updated } = await db
    .from("snapshot_jobs")
    .update({ notification_mask: currentMask | bit })
    .eq("id", jobId)
    .eq("notification_mask", currentMask)
    .select("id")
    .maybeSingle();

  return !!updated;
}

/**
 * Send a milestone push to the job's owner. Atomic + idempotent.
 *
 * @param customBody  Optional override body (e.g. completion uses diff data).
 */
// deno-lint-ignore no-explicit-any
export async function sendMilestoneNotification(
  db: any,
  jobId: string,
  userId: string,
  igAccountId: string,
  milestone: MilestoneName,
  customBody?: string,
): Promise<void> {
  try {
    const claimed = await claimMilestone(db, jobId, milestone);
    if (!claimed) return;

    // Pref gating for terminal milestones only.
    if (milestone === "COMPLETE" || milestone === "FAILED") {
      const { data: prefs } = await db.from("user_settings")
        .select("notify_refresh_complete")
        .eq("user_id", userId)
        .maybeSingle();
      if (prefs?.notify_refresh_complete === false) return;
    }
    if (milestone === "RECONNECT_REQUIRED") {
      const { data: prefs } = await db.from("user_settings")
        .select("notify_on_token_expiry")
        .eq("user_id", userId)
        .maybeSingle();
      if (prefs?.notify_on_token_expiry === false) return;
    }

    const { data: profile } = await db.from("profiles")
      .select("push_token")
      .eq("id", userId)
      .maybeSingle();
    if (!profile?.push_token) return;

    const spec = SPECS[milestone];
    const body = customBody ?? spec.body;
    await sendPushNotification(
      profile.push_token,
      spec.title,
      body,
      {
        screen: milestone === "RECONNECT_REQUIRED" ? "settings" : "dashboard",
        jobId,
        igAccountId,
        milestone,
      },
    );
    // Update last_notified_percent for visible milestones.
    const percentByMilestone: Partial<Record<MilestoneName, number>> = {
      STARTED: 0, P25: 25, P50: 50, P75: 75, ALMOST_DONE: 90, COMPLETE: 100,
    };
    const p = percentByMilestone[milestone];
    if (p !== undefined) {
      await db.from("snapshot_jobs")
        .update({ last_notified_percent: p })
        .eq("id", jobId)
        .lt("last_notified_percent", p);
    }
    console.log(`[notify] job=${jobId} milestone=${milestone} sent`);
  } catch (err) {
    console.warn(`[notify] job=${jobId} milestone=${milestone} error:`, (err as Error).message);
  }
}

/**
 * Map a progress percent to the highest milestone bit eligible for sending.
 * Returns the list of milestones that should be sent based on current percent.
 * Caller still calls sendMilestoneNotification per milestone to enforce idempotency.
 */
export function milestonesForPercent(percent: number): MilestoneName[] {
  const out: MilestoneName[] = [];
  if (percent >= 25) out.push("P25");
  if (percent >= 50) out.push("P50");
  if (percent >= 75) out.push("P75");
  if (percent >= 90) out.push("ALMOST_DONE");
  return out;
}
