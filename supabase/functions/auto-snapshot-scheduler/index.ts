/// <reference path="../deno-types.d.ts" />
// auto-snapshot-scheduler/index.ts
//
// Scheduled Edge Function — runs every 10–15 minutes (via pg_cron or external scheduler).
// Triggers one automatic snapshot per eligible user when their local time
// falls within the scheduling window (default 11:30–13:30 local).
//
// Eligibility rules:
//   1. ig_accounts.auto_snapshot_enabled = true
//   2. ig_accounts.status = 'active' (no auth/risk warnings)
//   3. ig_accounts.deleted_at IS NULL
//   4. User opened app within the last 7 days (profiles.last_app_open_at)
//   5. No auto snapshot already taken today in user's LOCAL date
//   6. auto_snapshot_fail_count < MAX_FAIL_COUNT with exponential backoff
//   7. No currently running/queued job for this account
//   8. Daily cap not reached (shared with manual)
//   9. Hourly cooldown since last snapshot (manual or auto)
//  10. reconnect_required = false
//
// Automatic snapshots count against the user's daily quota (3/day cap).
//
// POST /auto-snapshot-scheduler
// Auth: service-role key or CRON_SECRET
//
// Design: conservative, transparent, no evasion behavior.
// Processes accounts sequentially to avoid thundering herd.
// Logs every decision with timezone context for operational visibility.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { adminClient }                         from "../_shared/supabase_client.ts";

/** Maximum accounts to process per invocation (safety valve). */
const MAX_BATCH_SIZE = 100;

/** Accounts with this many consecutive auto-snapshot failures are paused. */
const MAX_FAIL_COUNT = 3;

/** How recently the user must have opened the app (7 days). */
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

/** Daily snapshot cap (shared with manual). */
const DAILY_SNAPSHOT_CAP = 3;

/** Hourly cooldown between any snapshots. */
const SNAPSHOT_COOLDOWN_MS = 1 * 60 * 60 * 1_000;

/** Target scheduling window — local time boundaries (24h format). */
const WINDOW_START_HOUR = 11;
const WINDOW_START_MIN  = 30;
const WINDOW_END_HOUR   = 13;
const WINDOW_END_MIN    = 30;

/** Backoff base (minutes) for exponential backoff on repeated failures. */
const BACKOFF_BASE_MINUTES = 30; // 30min, 60min, 120min for fail_count 1,2,3

// ── Timezone helpers ──────────────────────────────────────────────────────

/**
 * Returns the current local time in a given IANA timezone.
 * Falls back to UTC if the timezone string is invalid.
 */
function getLocalTime(timezone: string | null): { hours: number; minutes: number; localDateStr: string; tzUsed: string } {
  const tz = timezone ?? "UTC";
  try {
    const now = new Date();
    // Use Intl to get local hour/minute
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hours = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const minutes = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);

    // Get local date string (YYYY-MM-DD) for "already today" check
    const dateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now); // en-CA gives YYYY-MM-DD format

    return { hours, minutes, localDateStr: dateParts, tzUsed: tz };
  } catch {
    // Invalid timezone — fall back to UTC
    const now = new Date();
    return {
      hours: now.getUTCHours(),
      minutes: now.getUTCMinutes(),
      localDateStr: now.toISOString().slice(0, 10),
      tzUsed: "UTC",
    };
  }
}

/**
 * Returns true if the given local time falls within the scheduling window.
 */
function isInSchedulingWindow(hours: number, minutes: number): boolean {
  const totalMinutes = hours * 60 + minutes;
  const windowStart  = WINDOW_START_HOUR * 60 + WINDOW_START_MIN;
  const windowEnd    = WINDOW_END_HOUR * 60 + WINDOW_END_MIN;
  return totalMinutes >= windowStart && totalMinutes <= windowEnd;
}

/**
 * Returns the local date string (YYYY-MM-DD) of a UTC timestamp
 * interpreted in the given timezone.
 */
function utcToLocalDate(utcIso: string, timezone: string): string {
  try {
    const d = new Date(utcIso);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    // Fallback: use UTC date
    return utcIso.slice(0, 10);
  }
}

/**
 * Returns whether the account is still in exponential backoff cooldown.
 * Backoff formula: BACKOFF_BASE_MINUTES * 2^(fail_count - 1)
 */
function isInBackoffCooldown(
  failCount: number,
  lastFailAt: string | null,
  now: Date,
): { inCooldown: boolean; cooldownMinutes: number; remainingMinutes: number } {
  if (failCount === 0 || !lastFailAt) return { inCooldown: false, cooldownMinutes: 0, remainingMinutes: 0 };
  if (failCount >= MAX_FAIL_COUNT) return { inCooldown: true, cooldownMinutes: Infinity, remainingMinutes: Infinity };

  const cooldownMinutes = BACKOFF_BASE_MINUTES * Math.pow(2, failCount - 1);
  const cooldownMs = cooldownMinutes * 60_000;
  const failTime = new Date(lastFailAt).getTime();
  const elapsed = now.getTime() - failTime;
  const remaining = Math.max(0, cooldownMs - elapsed);

  return {
    inCooldown: elapsed < cooldownMs,
    cooldownMinutes,
    remainingMinutes: Math.ceil(remaining / 60_000),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();

  // ── Auth: service-role or cron secret ─────────────────────────
  const authHeader = req.headers.get("Authorization") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const token = authHeader.replace("Bearer ", "");

  if (token !== serviceKey && token !== cronSecret) {
    return jsonResponse({ error: "Unauthorized — service role required" }, 401);
  }

  const db = adminClient();
  const now = new Date();
  const activeWindowIso = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
  const windowStart24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();

  const stats = {
    eligible: 0,
    scheduled: 0,
    skipped_already_today: 0,
    skipped_daily_cap: 0,
    skipped_cooldown: 0,
    skipped_inactive: 0,
    skipped_fail_backoff: 0,
    skipped_running_job: 0,
    skipped_outside_window: 0,
    failed: 0,
    errors: [] as string[],
  };

  try {
    // ── 1. Find candidate accounts ──────────────────────────────
    // Join ig_accounts with profiles to check last_app_open_at + timezone
    const { data: accounts, error: queryErr } = await db
      .from("ig_accounts")
      .select(`
        id,
        user_id,
        auto_snapshot_enabled,
        auto_snapshot_fail_count,
        last_auto_snapshot_at,
        last_auto_snapshot_fail_at,
        last_snapshot_at,
        status,
        profiles!inner ( last_app_open_at, push_token, timezone )
      `)
      .eq("auto_snapshot_enabled", true)
      .eq("status", "active")
      .eq("reconnect_required", false)
      .is("deleted_at", null)
      .lt("auto_snapshot_fail_count", MAX_FAIL_COUNT)
      .limit(MAX_BATCH_SIZE);

    if (queryErr) {
      console.error("[auto-snapshot] Query error:", queryErr.message);
      return jsonResponse({ error: queryErr.message }, 500);
    }

    if (!accounts || accounts.length === 0) {
      console.log("[auto-snapshot] No eligible accounts found.");
      return jsonResponse({ ...stats, message: "No eligible accounts" });
    }

    stats.eligible = accounts.length;

    // ── 2. Process each account ──────────────────────────────────
    for (const acct of accounts) {
      const profile = acct.profiles as unknown as {
        last_app_open_at: string | null;
        push_token: string | null;
        timezone: string | null;
      };
      const igAccountId = acct.id as string;
      const userId = acct.user_id as string;
      const userTimezone = profile.timezone;

      // Get user's local time for scheduling decisions
      const local = getLocalTime(userTimezone);

      // Check: user's local time within scheduling window?
      if (!isInSchedulingWindow(local.hours, local.minutes)) {
        stats.skipped_outside_window++;
        console.log(`[auto-snapshot] Skipped ${igAccountId}: outside scheduling window (local ${local.hours}:${String(local.minutes).padStart(2, '0')} ${local.tzUsed}, window ${WINDOW_START_HOUR}:${String(WINDOW_START_MIN).padStart(2, '0')}–${WINDOW_END_HOUR}:${String(WINDOW_END_MIN).padStart(2, '0')})`);
        continue;
      }

      // Check: user recently active?
      if (!profile.last_app_open_at || new Date(profile.last_app_open_at) < new Date(activeWindowIso)) {
        stats.skipped_inactive++;
        console.log(`[auto-snapshot] Skipped ${igAccountId}: user inactive (last open: ${profile.last_app_open_at ?? 'never'})`);
        continue;
      }

      // Check: already had auto snapshot today (in user's local date)?
      if (acct.last_auto_snapshot_at) {
        const lastAutoLocalDate = utcToLocalDate(acct.last_auto_snapshot_at as string, local.tzUsed);
        if (lastAutoLocalDate === local.localDateStr) {
          stats.skipped_already_today++;
          console.log(`[auto-snapshot] Skipped ${igAccountId}: already had auto snapshot today (local date ${local.localDateStr}, tz=${local.tzUsed})`);
          continue;
        }
      }

      // Check: exponential backoff cooldown
      const backoff = isInBackoffCooldown(
        acct.auto_snapshot_fail_count as number,
        acct.last_auto_snapshot_fail_at as string | null,
        now,
      );
      if (backoff.inCooldown) {
        stats.skipped_fail_backoff++;
        console.log(`[auto-snapshot] Skipped ${igAccountId}: in backoff cooldown (fail_count=${acct.auto_snapshot_fail_count}, cooldown=${backoff.cooldownMinutes}min, remaining=${backoff.remainingMinutes}min)`);
        continue;
      }

      // Check: hourly cooldown from last snapshot (manual or auto)
      if (acct.last_snapshot_at) {
        const lastMs = new Date(acct.last_snapshot_at as string).getTime();
        if (now.getTime() - lastMs < SNAPSHOT_COOLDOWN_MS) {
          stats.skipped_cooldown++;
          console.log(`[auto-snapshot] Skipped ${igAccountId}: within hourly cooldown`);
          continue;
        }
      }

      // Check: daily cap (count completed snapshots in the last 24h)
      const { data: recentJobs } = await db
        .from("snapshot_jobs")
        .select("id")
        .eq("ig_account_id", igAccountId)
        .eq("status", "complete")
        .gte("updated_at", windowStart24h);

      if (recentJobs && recentJobs.length >= DAILY_SNAPSHOT_CAP) {
        stats.skipped_daily_cap++;
        console.log(`[auto-snapshot] Skipped ${igAccountId}: daily cap reached (${recentJobs.length}/${DAILY_SNAPSHOT_CAP})`);
        continue;
      }

      // Check: no running/queued job (concurrency safety)
      const { data: activeJob } = await db
        .from("snapshot_jobs")
        .select("id")
        .eq("ig_account_id", igAccountId)
        .in("status", ["running", "queued"])
        .maybeSingle();

      if (activeJob) {
        stats.skipped_running_job++;
        console.log(`[auto-snapshot] Skipped ${igAccountId}: job already running/queued (job=${activeJob.id})`);
        continue;
      }

      // ── 3. Trigger snapshot via snapshot-start (internal call) ──
      try {
        // Log the scheduling event with timezone context
        await db.from("funnel_events").insert({
          user_id:    userId,
          event_name: "auto_snapshot_scheduled",
          payload:    {
            ig_account_id: igAccountId,
            trigger: "scheduler",
            timezone: local.tzUsed,
            local_time: `${local.hours}:${String(local.minutes).padStart(2, '0')}`,
            local_date: local.localDateStr,
            snapshots_today: recentJobs?.length ?? 0,
          },
        }).then(() => {}).catch(() => {});

        // Call snapshot-start as service-role (it accepts source='cron')
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const res = await fetch(`${supabaseUrl}/functions/v1/snapshot-start`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
          },
          body: JSON.stringify({
            ig_account_id: igAccountId,
            source: "cron",
          }),
        });

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const errMsg = (body as Record<string, unknown>).error ?? `HTTP ${res.status}`;
          throw new Error(String(errMsg));
        }

        const result = await res.json();
        const jobId = (result as Record<string, unknown>).jobId;

        // Update auto snapshot tracking — reset fail state on success
        await db.from("ig_accounts").update({
          last_auto_snapshot_at:      now.toISOString(),
          auto_snapshot_fail_count:   0,
          last_auto_snapshot_error:   null,
          last_auto_snapshot_fail_at: null,
          updated_at:                 now.toISOString(),
        }).eq("id", igAccountId);

        // Log analytics with timezone context
        await db.from("funnel_events").insert({
          user_id:    userId,
          event_name: "auto_snapshot_started",
          payload:    {
            ig_account_id: igAccountId,
            job_id: jobId,
            timezone: local.tzUsed,
            local_time: `${local.hours}:${String(local.minutes).padStart(2, '0')}`,
            snapshots_today: (recentJobs?.length ?? 0) + 1,
          },
        }).then(() => {}).catch(() => {});

        stats.scheduled++;
        console.log(`[auto-snapshot] Started job for ${igAccountId}: jobId=${jobId} (tz=${local.tzUsed}, local=${local.hours}:${String(local.minutes).padStart(2, '0')}, date=${local.localDateStr})`);

      } catch (err) {
        const errMsg = (err as Error).message;

        // Increment failure count with backoff tracking
        const newFailCount = ((acct.auto_snapshot_fail_count as number) ?? 0) + 1;
        await db.from("ig_accounts").update({
          auto_snapshot_fail_count:   newFailCount,
          last_auto_snapshot_error:   errMsg,
          last_auto_snapshot_fail_at: now.toISOString(),
          updated_at:                 now.toISOString(),
        }).eq("id", igAccountId);

        // Log failure analytics
        await db.from("funnel_events").insert({
          user_id:    userId,
          event_name: "auto_snapshot_skipped",
          payload:    {
            ig_account_id: igAccountId,
            reason: "start_failed",
            error: errMsg,
            fail_count: newFailCount,
            timezone: local.tzUsed,
            local_time: `${local.hours}:${String(local.minutes).padStart(2, '0')}`,
          },
        }).then(() => {}).catch(() => {});

        stats.failed++;
        stats.errors.push(`${igAccountId}: ${errMsg}`);
        console.error(`[auto-snapshot] Failed for ${igAccountId}: ${errMsg} (fail_count=${newFailCount}, tz=${local.tzUsed})`);
      }
    }
  } catch (err) {
    console.error("[auto-snapshot] Top-level error:", (err as Error).message);
    return jsonResponse({ error: (err as Error).message, stats }, 500);
  }

  console.log("[auto-snapshot] Run complete:", JSON.stringify(stats));
  return jsonResponse(stats);
});
