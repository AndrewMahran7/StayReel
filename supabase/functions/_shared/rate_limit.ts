// _shared/rate_limit.ts
// Snapshot rate limiting:
//   • 1-hour cooldown between snapshots (per IG account)
//   • 3 snapshots maximum per 24-hour rolling window (per IG account)
// Both enforced via ig_accounts.last_snapshot_at and snapshot_jobs.

import { adminClient } from "./supabase_client.ts";
import { Errors } from "./errors.ts";
import { writeAuditEvent } from "./audit.ts";

export type QuotaType = "manual" | "cron";

/** Minimum gap between manual snapshots (ms) — 1 hour. */
const SNAPSHOT_COOLDOWN_MS = 1 * 60 * 60 * 1_000;

/** Maximum number of manual snapshots allowed in any rolling 24-hour window. */
const DAILY_SNAPSHOT_CAP = 3;

/**
 * Enforces:
 *   1. A 1-hour cooldown between snapshots.
 *   2. A rolling 24-hour cap of DAILY_SNAPSHOT_CAP completed snapshots.
 *
 * Reads ig_accounts.last_snapshot_at for the cooldown, and counts recent
 * completed snapshot_jobs rows for the daily cap.
 * Throws Errors.snapshotLimit(nextAllowedAt) when either limit is breached.
 */
export async function checkAndEnforce24hLimit(
  userId: string,
  igAccountId: string,
): Promise<void> {
  const db = adminClient();

  // ── 1. Hourly cooldown ────────────────────────────────────────────────────
  const { data: acct } = await db
    .from("ig_accounts")
    .select("last_snapshot_at")
    .eq("id", igAccountId)
    .maybeSingle();

  if (acct?.last_snapshot_at) {
    const lastMs    = new Date(acct.last_snapshot_at).getTime();
    const nowMs     = Date.now();
    const elapsedMs = nowMs - lastMs;

    if (elapsedMs < SNAPSHOT_COOLDOWN_MS) {
      const nextAllowedAt = new Date(lastMs + SNAPSHOT_COOLDOWN_MS).toISOString();

      await writeAuditEvent({
        userId,
        igAccountId,
        eventType: "rate_limit_hit",
        payload: {
          limit_type:       "hourly_cooldown",
          last_snapshot_at: acct.last_snapshot_at,
          next_allowed_at:  nextAllowedAt,
        },
      }).catch(() => {});

      throw Errors.snapshotLimit(
        nextAllowedAt,
        "You can take one snapshot per hour.",
      );
    }
  }

  // ── 2. Daily cap (rolling 24-hour window) ────────────────────────────────
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();

  const { data: recentJobs } = await db
    .from("snapshot_jobs")
    .select("updated_at")
    .eq("ig_account_id", igAccountId)
    .eq("status", "complete")
    .gte("updated_at", windowStart)
    .order("updated_at", { ascending: true });

  if (recentJobs && recentJobs.length >= DAILY_SNAPSHOT_CAP) {
    // Unlock when the oldest job in the window rolls out of the 24-hour window.
    const oldestAt      = (recentJobs[0] as { updated_at: string }).updated_at;
    const nextAllowedAt = new Date(
      new Date(oldestAt).getTime() + 24 * 60 * 60 * 1_000,
    ).toISOString();

    await writeAuditEvent({
      userId,
      igAccountId,
      eventType: "rate_limit_hit",
      payload: {
        limit_type:      "daily_cap",
        snapshots_today: recentJobs.length,
        next_allowed_at: nextAllowedAt,
      },
    }).catch(() => {});

    throw Errors.snapshotLimit(
      nextAllowedAt,
      `You've reached the daily limit of ${DAILY_SNAPSHOT_CAP} snapshots. This keeps your account safe.`,
    );
  }
}

/** @deprecated Use checkAndEnforce24hLimit for manual captures. Kept for cron. */
export async function checkAndConsumeQuota(
  _userId: string,
  type: QuotaType = "manual",
): Promise<void> {
  // Cron has no per-account daily limit.
  // Manual captures are now gated by checkAndEnforce24hLimit.
}

/** @deprecated Replaced by checkAndEnforce24hLimit. */
export async function checkSnapshotCadence(
  _userId: string,
  _igAccountId: string,
): Promise<void> {
  // No-op.
}

