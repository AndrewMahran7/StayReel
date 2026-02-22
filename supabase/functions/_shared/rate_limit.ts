// _shared/rate_limit.ts
// Snapshot rate limiting: one snapshot per 24 hours per IG account.
// Enforced via ig_accounts.last_snapshot_at on the backend.

import { adminClient } from "./supabase_client.ts";
import { Errors } from "./errors.ts";
import { writeAuditEvent } from "./audit.ts";

export type QuotaType = "manual" | "cron";

/** 24-hour gap between manual snapshots (ms). */
const DAILY_LIMIT_MS = 24 * 60 * 60 * 1_000;

/**
 * Enforces one snapshot per 24 hours per IG account.
 * Reads ig_accounts.last_snapshot_at.
 * Throws Errors.snapshotLimit(nextAllowedAt) when within the limit window.
 */
export async function checkAndEnforce24hLimit(
  userId: string,
  igAccountId: string,
): Promise<void> {
  const { data: acct } = await adminClient()
    .from("ig_accounts")
    .select("last_snapshot_at")
    .eq("id", igAccountId)
    .maybeSingle();

  if (!acct?.last_snapshot_at) return; // first snapshot — always allow

  const lastMs    = new Date(acct.last_snapshot_at).getTime();
  const nowMs     = Date.now();
  const elapsedMs = nowMs - lastMs;

  if (elapsedMs < DAILY_LIMIT_MS) {
    const nextAllowedAt = new Date(lastMs + DAILY_LIMIT_MS).toISOString();

    await writeAuditEvent({
      userId,
      igAccountId,
      eventType: "rate_limit_hit",
      payload: {
        limit_type:       "daily_snapshot",
        last_snapshot_at: acct.last_snapshot_at,
        next_allowed_at:  nextAllowedAt,
      },
    }).catch(() => {});

    throw Errors.snapshotLimit(nextAllowedAt);
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

