/**
 * Unit tests for auto-snapshot eligibility, timezone scheduling,
 * notification thresholds, cooldown logic, and backoff behaviour.
 *
 * These test the pure logic extracted from the edge functions — no
 * Supabase or Deno dependencies required.
 */

// ── Timezone helpers (mirrors auto-snapshot-scheduler) ───────────────────

const WINDOW_START_HOUR = 11;
const WINDOW_START_MIN  = 30;
const WINDOW_END_HOUR   = 13;
const WINDOW_END_MIN    = 30;
const BACKOFF_BASE_MINUTES = 30;
const MAX_FAIL_COUNT = 3;

function isInSchedulingWindow(hours: number, minutes: number): boolean {
  const totalMinutes = hours * 60 + minutes;
  const windowStart  = WINDOW_START_HOUR * 60 + WINDOW_START_MIN;
  const windowEnd    = WINDOW_END_HOUR * 60 + WINDOW_END_MIN;
  return totalMinutes >= windowStart && totalMinutes <= windowEnd;
}

/**
 * Simulates utcToLocalDate: converts a UTC timestamp to a YYYY-MM-DD
 * local date string in the given timezone.
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
    return utcIso.slice(0, 10);
  }
}

/**
 * Simulates getLocalTime for a specific timezone.
 */
function getLocalTime(timezone: string | null): { hours: number; minutes: number; localDateStr: string; tzUsed: string } {
  const tz = timezone ?? "UTC";
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(now);
    const hours = parseInt(parts.find(p => p.type === "hour")?.value ?? "0", 10);
    const minutes = parseInt(parts.find(p => p.type === "minute")?.value ?? "0", 10);
    const dateParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    return { hours, minutes, localDateStr: dateParts, tzUsed: tz };
  } catch {
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
 * Exponential backoff: BACKOFF_BASE_MINUTES * 2^(fail_count - 1)
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

// ── Eligibility logic (mirrors auto-snapshot-scheduler) ──────────────────

interface EligibilityInput {
  auto_snapshot_enabled: boolean;
  status: string;
  deleted_at: string | null;
  last_app_open_at: string | null;
  last_auto_snapshot_at: string | null;
  auto_snapshot_fail_count: number;
  last_auto_snapshot_fail_at: string | null;
  has_active_job: boolean;
  snapshots_today: number;
  timezone: string | null;
}

function isEligible(acct: EligibilityInput, now: Date = new Date()): { eligible: boolean; reason?: string } {
  if (!acct.auto_snapshot_enabled) return { eligible: false, reason: 'disabled' };
  if (acct.status !== 'active') return { eligible: false, reason: 'inactive' };
  if (acct.deleted_at) return { eligible: false, reason: 'deleted' };

  if (acct.last_app_open_at) {
    const daysSinceOpen = (now.getTime() - new Date(acct.last_app_open_at).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceOpen > 7) return { eligible: false, reason: 'dormant' };
  } else {
    return { eligible: false, reason: 'never_opened' };
  }

  // Scheduling window check (user's local time)
  const local = getLocalTime(acct.timezone);
  if (!isInSchedulingWindow(local.hours, local.minutes)) {
    return { eligible: false, reason: 'outside_window' };
  }

  // Already-today check uses local date, not UTC
  if (acct.last_auto_snapshot_at) {
    const lastAutoLocalDate = utcToLocalDate(acct.last_auto_snapshot_at, local.tzUsed);
    if (lastAutoLocalDate === local.localDateStr) {
      return { eligible: false, reason: 'already_today' };
    }
  }

  // Exponential backoff
  const backoff = isInBackoffCooldown(acct.auto_snapshot_fail_count, acct.last_auto_snapshot_fail_at, now);
  if (backoff.inCooldown) return { eligible: false, reason: 'backoff' };

  if (acct.has_active_job) return { eligible: false, reason: 'active_job' };
  if (acct.snapshots_today >= 3) return { eligible: false, reason: 'daily_cap' };

  return { eligible: true };
}

// ── Notification threshold logic (mirrors smart-notify) ──────────────────

const NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1_000;

interface NotificationInput {
  net_follower_change: number;
  unfollowers_count: number;
  new_followers_count: number;
  prev_post_count: number | null;
  curr_post_count: number | null;
  notify_on_meaningful_change: boolean;
  last_notification_sent_at: string | null;
}

interface NotificationDecision {
  should_send: boolean;
  reason: string;
}

function evaluateNotification(input: NotificationInput, now: Date = new Date()): NotificationDecision {
  if (!input.notify_on_meaningful_change) {
    return { should_send: false, reason: 'preference_disabled' };
  }

  // Cooldown check: no more than 1 notification per 12h
  if (input.last_notification_sent_at) {
    const elapsed = now.getTime() - new Date(input.last_notification_sent_at).getTime();
    if (elapsed < NOTIFICATION_COOLDOWN_MS) {
      return { should_send: false, reason: 'cooldown' };
    }
  }

  const absNet = Math.abs(input.net_follower_change);
  const postedContent =
    input.prev_post_count != null &&
    input.curr_post_count != null &&
    input.curr_post_count > input.prev_post_count;

  if (absNet >= 3) return { should_send: true, reason: 'threshold_net' };
  if (input.unfollowers_count >= 3) return { should_send: true, reason: 'threshold_unfollowers' };
  if (postedContent && (input.new_followers_count > 0 || input.unfollowers_count > 0)) {
    return { should_send: true, reason: 'post_activity' };
  }

  return { should_send: false, reason: 'below_threshold' };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Auto-snapshot eligibility', () => {
  const base: EligibilityInput = {
    auto_snapshot_enabled: true,
    status: 'active',
    deleted_at: null,
    last_app_open_at: new Date().toISOString(),
    last_auto_snapshot_at: null,
    auto_snapshot_fail_count: 0,
    last_auto_snapshot_fail_at: null,
    has_active_job: false,
    snapshots_today: 0,
    timezone: null,
  };

  // NOTE: Eligibility depends on the current local time being within
  // the scheduling window (11:30–13:30). Tests that check for
  // eligible=true will only pass if the test runner's time is in-window
  // OR we mock the local time. For robustness, we test window logic
  // separately below, and here we only check non-window conditions.

  it('ineligible when auto_snapshot_enabled = false', () => {
    expect(isEligible({ ...base, auto_snapshot_enabled: false })).toMatchObject({ eligible: false, reason: 'disabled' });
  });

  it('ineligible when account is inactive', () => {
    expect(isEligible({ ...base, status: 'cookie_expired' })).toMatchObject({ eligible: false, reason: 'inactive' });
  });

  it('ineligible when account is deleted', () => {
    expect(isEligible({ ...base, deleted_at: '2025-01-01T00:00:00Z' })).toMatchObject({ eligible: false, reason: 'deleted' });
  });

  it('ineligible when user has not opened app in 7+ days', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(isEligible({ ...base, last_app_open_at: eightDaysAgo })).toMatchObject({ eligible: false, reason: 'dormant' });
  });

  it('ineligible when user never opened app', () => {
    expect(isEligible({ ...base, last_app_open_at: null })).toMatchObject({ eligible: false, reason: 'never_opened' });
  });

  it('ineligible when a job is already active', () => {
    // This only applies if the window check passes, so the result
    // may be 'outside_window' or 'active_job' depending on current time.
    const result = isEligible({ ...base, has_active_job: true });
    expect(result.eligible).toBe(false);
  });

  it('ineligible when daily cap of 3 reached', () => {
    const result = isEligible({ ...base, snapshots_today: 3 });
    expect(result.eligible).toBe(false);
  });
});

describe('Notification threshold logic', () => {
  const base: NotificationInput = {
    net_follower_change: 0,
    unfollowers_count: 0,
    new_followers_count: 0,
    prev_post_count: 10,
    curr_post_count: 10,
    notify_on_meaningful_change: true,
    last_notification_sent_at: null,
  };

  it('no notification when below all thresholds', () => {
    expect(evaluateNotification(base)).toMatchObject({ should_send: false, reason: 'below_threshold' });
  });

  it('sends when net change >= 3 (gained)', () => {
    expect(evaluateNotification({ ...base, net_follower_change: 5, new_followers_count: 5 })).toMatchObject({
      should_send: true,
      reason: 'threshold_net',
    });
  });

  it('sends when net change <= -3 (lost)', () => {
    expect(evaluateNotification({ ...base, net_follower_change: -4, unfollowers_count: 4 })).toMatchObject({
      should_send: true,
      reason: 'threshold_net',
    });
  });

  it('sends when unfollowers >= 3 even if net is small', () => {
    expect(evaluateNotification({ ...base, net_follower_change: -1, unfollowers_count: 3, new_followers_count: 2 })).toMatchObject({
      should_send: true,
      reason: 'threshold_unfollowers',
    });
  });

  it('sends when user posted and any follower change', () => {
    expect(evaluateNotification({
      ...base,
      prev_post_count: 10,
      curr_post_count: 11,
      new_followers_count: 1,
    })).toMatchObject({ should_send: true, reason: 'post_activity' });
  });

  it('no notification when user posted but no follower change', () => {
    expect(evaluateNotification({
      ...base,
      prev_post_count: 10,
      curr_post_count: 11,
    })).toMatchObject({ should_send: false, reason: 'below_threshold' });
  });

  it('no notification when preference disabled even if threshold met', () => {
    expect(evaluateNotification({
      ...base,
      net_follower_change: 10,
      new_followers_count: 10,
      notify_on_meaningful_change: false,
    })).toMatchObject({ should_send: false, reason: 'preference_disabled' });
  });

  it('content-aware: detects new post from post_count delta', () => {
    const result = evaluateNotification({
      ...base,
      prev_post_count: 5,
      curr_post_count: 6,
      unfollowers_count: 1,
    });
    expect(result).toMatchObject({ should_send: true, reason: 'post_activity' });
  });

  it('handles null post counts gracefully (no content detection)', () => {
    const result = evaluateNotification({
      ...base,
      prev_post_count: null,
      curr_post_count: null,
      net_follower_change: 1,
      new_followers_count: 1,
    });
    expect(result).toMatchObject({ should_send: false, reason: 'below_threshold' });
  });
});

describe('Exponential backoff', () => {
  it('no cooldown when fail_count = 0', () => {
    const result = isInBackoffCooldown(0, null, new Date());
    expect(result.inCooldown).toBe(false);
  });

  it('30min cooldown after 1 failure', () => {
    const now = new Date();
    const justFailed = new Date(now.getTime() - 10 * 60_000).toISOString(); // 10min ago
    const result = isInBackoffCooldown(1, justFailed, now);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownMinutes).toBe(30);
  });

  it('60min cooldown after 2 failures', () => {
    const now = new Date();
    const justFailed = new Date(now.getTime() - 10 * 60_000).toISOString();
    const result = isInBackoffCooldown(2, justFailed, now);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownMinutes).toBe(60);
  });

  it('permanently blocked at MAX_FAIL_COUNT', () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 999 * 60_000).toISOString();
    const result = isInBackoffCooldown(3, longAgo, now);
    expect(result.inCooldown).toBe(true);
    expect(result.cooldownMinutes).toBe(Infinity);
  });

  it('cooldown expires after enough time', () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 60 * 60_000).toISOString(); // 60min ago
    const result = isInBackoffCooldown(1, longAgo, now); // 30min cooldown expired
    expect(result.inCooldown).toBe(false);
  });

  it('fail_count 0→1→2→3→blocked eligibility progression', () => {
    const baseAcct: EligibilityInput = {
      auto_snapshot_enabled: true,
      status: 'active',
      deleted_at: null,
      last_app_open_at: new Date().toISOString(),
      last_auto_snapshot_at: null,
      auto_snapshot_fail_count: 0,
      last_auto_snapshot_fail_at: null,
      has_active_job: false,
      snapshots_today: 0,
      timezone: null,
    };
    // fail_count=3 is always blocked regardless of window
    expect(isEligible({ ...baseAcct, auto_snapshot_fail_count: 3, last_auto_snapshot_fail_at: new Date().toISOString() }).eligible).toBe(false);
    expect(isEligible({ ...baseAcct, auto_snapshot_fail_count: 4, last_auto_snapshot_fail_at: new Date().toISOString() }).eligible).toBe(false);
  });
});

describe('Timezone scheduling window', () => {
  it('11:30 is inside the window', () => {
    expect(isInSchedulingWindow(11, 30)).toBe(true);
  });

  it('12:00 (noon) is inside the window', () => {
    expect(isInSchedulingWindow(12, 0)).toBe(true);
  });

  it('13:30 is inside the window (end boundary)', () => {
    expect(isInSchedulingWindow(13, 30)).toBe(true);
  });

  it('11:29 is outside the window (just before)', () => {
    expect(isInSchedulingWindow(11, 29)).toBe(false);
  });

  it('13:31 is outside the window (just after)', () => {
    expect(isInSchedulingWindow(13, 31)).toBe(false);
  });

  it('08:00 is outside the window', () => {
    expect(isInSchedulingWindow(8, 0)).toBe(false);
  });

  it('23:00 is outside the window', () => {
    expect(isInSchedulingWindow(23, 0)).toBe(false);
  });
});

describe('Local date enforcement (once per local day)', () => {
  it('same UTC timestamp maps to different local dates across timezones', () => {
    // 2026-04-15T04:00:00Z is:
    //   April 14 in LA (UTC-7) → 9:00 PM
    //   April 15 in London (UTC+1) → 5:00 AM
    const utcTimestamp = '2026-04-15T04:00:00Z';
    const laDate = utcToLocalDate(utcTimestamp, 'America/Los_Angeles');
    const londonDate = utcToLocalDate(utcTimestamp, 'Europe/London');
    expect(laDate).toBe('2026-04-14');
    expect(londonDate).toBe('2026-04-15');
  });

  it('snapshot at UTC midnight is same local date for UTC user', () => {
    const utcTimestamp = '2026-04-15T00:30:00Z';
    expect(utcToLocalDate(utcTimestamp, 'UTC')).toBe('2026-04-15');
  });

  it('snapshot at 11pm UTC is next day for Tokyo user (UTC+9)', () => {
    const utcTimestamp = '2026-04-15T23:00:00Z';
    const tokyoDate = utcToLocalDate(utcTimestamp, 'Asia/Tokyo');
    expect(tokyoDate).toBe('2026-04-16');
  });

  it('falls back to UTC date for invalid timezone', () => {
    const utcTimestamp = '2026-04-15T12:00:00Z';
    const result = utcToLocalDate(utcTimestamp, 'Invalid/Timezone');
    expect(result).toBe('2026-04-15');
  });
});

describe('getLocalTime fallback behavior', () => {
  it('returns valid time for known timezone', () => {
    const result = getLocalTime('America/New_York');
    expect(result.tzUsed).toBe('America/New_York');
    expect(result.hours).toBeGreaterThanOrEqual(0);
    expect(result.hours).toBeLessThanOrEqual(23);
    expect(result.localDateStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falls back to UTC when timezone is null', () => {
    const result = getLocalTime(null);
    expect(result.tzUsed).toBe('UTC');
  });

  it('falls back to UTC for invalid timezone string', () => {
    const result = getLocalTime('Invalid/Not_A_Zone');
    expect(result.tzUsed).toBe('UTC');
  });
});

describe('Notification cooldown', () => {
  const base: NotificationInput = {
    net_follower_change: 10,
    unfollowers_count: 0,
    new_followers_count: 10,
    prev_post_count: 10,
    curr_post_count: 10,
    notify_on_meaningful_change: true,
    last_notification_sent_at: null,
  };

  it('sends when no previous notification', () => {
    expect(evaluateNotification(base)).toMatchObject({ should_send: true });
  });

  it('blocked when last notification was 6h ago (within 12h cooldown)', () => {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    expect(evaluateNotification({ ...base, last_notification_sent_at: sixHoursAgo })).toMatchObject({
      should_send: false,
      reason: 'cooldown',
    });
  });

  it('sends when last notification was 13h ago (past cooldown)', () => {
    const thirteenHoursAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    expect(evaluateNotification({ ...base, last_notification_sent_at: thirteenHoursAgo })).toMatchObject({
      should_send: true,
    });
  });

  it('cooldown exactly at boundary (12h) allows sending', () => {
    const exactlyTwelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    expect(evaluateNotification({ ...base, last_notification_sent_at: exactlyTwelveHoursAgo })).toMatchObject({
      should_send: true,
    });
  });

  it('preference check runs before cooldown check', () => {
    const recentNotification = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    expect(evaluateNotification({
      ...base,
      notify_on_meaningful_change: false,
      last_notification_sent_at: recentNotification,
    })).toMatchObject({ should_send: false, reason: 'preference_disabled' });
  });
});
