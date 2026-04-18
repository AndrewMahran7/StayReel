# Implementation Notes: Auto Snapshots & Smart Notifications

## Overview

This update adds four capabilities:

1. **Automatic daily snapshots** — a backend scheduler takes one snapshot per eligible account per day
2. **Smart notifications** — push notifications only when meaningful follower changes are detected
3. **Product clarity UX** — "How StayReel Works" modal, snapshot status card, contextual help
4. **Settings controls** — toggles for auto-snapshot and meaningful-change notifications

---

## Architecture

### Auto Snapshot Flow

```
CRON (every 10–15 minutes)
  → auto-snapshot-scheduler (edge function)
    → For each eligible ig_account:
        → Derive user’s local time from profiles.timezone
        → Skip if local time outside 11:30–13:30 window
        → Skip if already snapshotted today (user’s local date)
        → POST /snapshot-start { source: "cron" }
          → Existing resumable job pipeline (followers → following → finalize)
            → On complete: POST /smart-notify { diff_id, ig_account_id, user_id, job_id }
              → Evaluate thresholds + cooldown → conditionally send push
```

### Eligibility Rules

An account is eligible for auto-snapshot when ALL conditions are met:

| Rule                          | Check                                            |
|-------------------------------|--------------------------------------------------|
| Auto-snapshot enabled         | `ig_accounts.auto_snapshot_enabled = true`       |
| Account active                | `ig_accounts.status = 'active'`                  |
| Not deleted                   | `ig_accounts.deleted_at IS NULL`                 |
| User recently active          | `profiles.last_app_open_at` within 7 days        |
| In scheduling window          | User’s local time is 11:30–13:30                |
| Not already snapshotted today | `last_auto_snapshot_at` not same **local** date  |
| Below failure backoff         | Exponential backoff: 30min × 2^(n-1), max 3      |
| No concurrent job             | No running/pending snapshot_jobs for this account|
| Within daily cap              | < 3 completed snapshots in rolling 24h window    |
| Not reconnect-required        | `ig_accounts.reconnect_required = false`         |

### Notification Threshold Rules

Smart-notify sends a push when ANY of these are true **AND** notification cooldown (12h) has not been hit:

| Condition                           | Threshold                                  |
|-------------------------------------|--------------------------------------------|
| Net follower change (abs)           | ≥ 3                                        |
| Unfollowers count                   | ≥ 3                                        |
| User posted new content + any change| `post_count` increased AND followers changed|

The notification is **skipped** if:
- `user_settings.notify_on_meaningful_change = false`
- Last notification was sent less than 12 hours ago (`profiles.last_notification_sent_at`)
- None of the thresholds are met

### Content-Aware Copy

| Scenario              | Push body                                                    |
|-----------------------|--------------------------------------------------------------|
| User posted + change  | "Your audience changed after your latest post — tap to see." |
| Gained followers      | "You gained 6 new followers today. Tap to see who."          |
| Lost followers        | "6 people unfollowed you today. Tap to see the details."     |

---

## Files Changed / Created

### New Files

| File                                              | Purpose                                      |
|--------------------------------------------------|----------------------------------------------|
| `supabase/migrations/026_auto_snapshot_support.sql` | Schema: new columns + indexes              |
| `supabase/migrations/028_timezone_and_notification_cooldown.sql` | Timezone, cooldown, backoff fields |
| `supabase/functions/auto-snapshot-scheduler/index.ts` | CRON-triggered scheduler (every 10–15min)  |
| `supabase/functions/smart-notify/index.ts`        | Threshold-based notification evaluator       |
| `components/HowItWorksModal.tsx`                  | 5-step explainer modal                       |
| `components/SnapshotStatusCard.tsx`               | Dashboard status card (last/next/remaining)  |
| `hooks/useAutoSnapshotSetting.ts`                 | Read/write auto_snapshot_enabled toggle      |
| `lib/reconnectCopy.ts`                            | Centralized user-facing reconnect copy       |
| `__tests__/autoSnapshot.test.ts`                  | 41 unit tests for eligibility, timezone, cooldown |
| `__tests__/sessionExpiry.test.ts`                 | 82 unit tests for session expiry + reconnect UX |

### Modified Files

| File                                    | Changes                                             |
|----------------------------------------|-----------------------------------------------------|
| `app/(tabs)/dashboard.tsx`              | Status card, contextual help, How It Works modal; reconnect copy from `lib/reconnectCopy.ts`, `needsReconnect` priority order, `SnapshotStatusCard` reconnect prop |
| `app/_layout.tsx`                       | `last_app_open_at` + timezone tracking on open/foreground |
| `app/(tabs)/settings.tsx`               | Auto-snapshot toggle, meaningful change toggle, How It Works link |
| `hooks/useNotificationSettings.ts`      | Added `notify_on_meaningful_change` field           |
| `lib/analytics.ts`                      | 6 auto-snapshot events + 3 reconnect lifecycle events (`reconnect_required_entered`, `reconnect_notification_sent`, `reconnect_completed`) |
| `supabase/functions/_shared/snapshotJob.ts` | Smart-notify call after cron job completes; reconnect analytics events      |
| `supabase/functions/smart-notify/index.ts`  | 12h notification cooldown + `last_notification_sent_at` |
| `supabase/functions/diffs-latest/index.ts`  | Returns `auto_snapshot_enabled`, `last_auto_snapshot_at` |
| `supabase/functions/snapshot-start/index.ts`     | Returns structured JSON (HTTP 200) for reconnect instead of throwing AppError |
| `supabase/functions/snapshot-continue/index.ts`  | Uses `RECONNECT_REQUIRED` failure_code + `tracking_state` |
| `hooks/useSnapshotCapture.ts`           | Checks `body.reconnect_required` before error handling      |
| `app/(auth)/connect-instagram.tsx`      | `reconnect_completed` analytics event on successful connect |
| `components/SnapshotStatusCard.tsx`          | Clarified "Remaining today (auto + manual)" copy; reconnect-aware paused state |

---

## Database Schema Additions (Migration 026 + 028)

```sql
-- profiles (026)
ALTER TABLE profiles ADD COLUMN last_app_open_at timestamptz;

-- profiles (028)
ALTER TABLE profiles ADD COLUMN timezone text;
ALTER TABLE profiles ADD COLUMN last_notification_sent_at timestamptz;

-- ig_accounts (026)
ALTER TABLE ig_accounts ADD COLUMN auto_snapshot_enabled boolean DEFAULT true;
ALTER TABLE ig_accounts ADD COLUMN last_auto_snapshot_at timestamptz;
ALTER TABLE ig_accounts ADD COLUMN auto_snapshot_fail_count integer DEFAULT 0;
ALTER TABLE ig_accounts ADD COLUMN last_auto_snapshot_error text;

-- ig_accounts (028)
ALTER TABLE ig_accounts ADD COLUMN last_auto_snapshot_fail_at timestamptz;

-- user_settings (026)
ALTER TABLE user_settings ADD COLUMN notify_on_meaningful_change boolean DEFAULT true;

-- follower_snapshots (026)
ALTER TABLE follower_snapshots ADD COLUMN post_count integer;
ALTER TABLE follower_snapshots ADD COLUMN story_count integer;

-- diffs (026)
ALTER TABLE diffs ADD COLUMN notification_sent boolean DEFAULT false;
ALTER TABLE diffs ADD COLUMN notification_reason text;
ALTER TABLE diffs ADD COLUMN notification_skipped_reason text;
```

---

## Analytics Events

| Event                       | When                                           |
|-----------------------------|------------------------------------------------|
| `auto_snapshot_scheduled`   | Scheduler selects an account for auto-snapshot  |
| `auto_snapshot_started`     | snapshot-start called with source=cron          |
| `auto_snapshot_completed`   | Auto snapshot job finalized successfully        |
| `auto_snapshot_skipped`     | Account skipped with reason                     |
| `meaningful_change_detected`| smart-notify evaluates threshold (sent or not)  |
| `notification_sent`         | Push notification dispatched                    |
| `reconnect_required_entered`| Account transitioned to reconnect_required state |
| `reconnect_notification_sent`| Reconnect push notification dispatched          |
| `reconnect_completed`      | User reconnected Instagram after session expiry  |

---

## Deployment Checklist

1. **Run migrations 026 + 028** — `supabase db push` or apply via dashboard
2. **Deploy edge functions** — `supabase functions deploy auto-snapshot-scheduler` and `smart-notify`
3. **Set up CRON** — Schedule `auto-snapshot-scheduler` to run every 10–15 minutes (e.g., `*/10 * * * *`)
   - Must pass `CRON_SECRET` header for authentication
   - Replaces the old daily `0 12 * * *` cron
4. **Deploy updated functions** — `snapshotJob.ts`, `diffs-latest/index.ts`
5. **Deploy app update** — new components, hooks, settings toggles

---

## Timezone Handling & Scheduling

### How local time is derived

The client reports its IANA timezone on every app open and foreground event:

```typescript
// app/_layout.tsx
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
supabase.from('profiles').update({ timezone, last_app_open_at: now }).eq('id', userId);
```

This populates `profiles.timezone` (e.g. `"America/Los_Angeles"`). The scheduler reads it on every run.

### Scheduling window logic

The scheduler runs every 10–15 minutes globally. For each eligible account, it:

1. Reads `profiles.timezone` (falls back to `"UTC"` if null or invalid)
2. Computes the user's local time via `Intl.DateTimeFormat` with `timeZone` option
3. Checks if local time is within the scheduling window: **11:30–13:30 local**
4. Skips the account if outside the window — it will be picked up on the next run

This means:
- A user in `America/Los_Angeles` (UTC-7) gets their snapshot between 18:30–20:30 UTC
- A user in `Asia/Tokyo` (UTC+9) gets theirs between 02:30–04:30 UTC
- A user in `Europe/London` (UTC+0/+1) gets theirs around 11:30–13:30 UTC

### How "once per day" is enforced per timezone

The "already snapshotted today" check converts `last_auto_snapshot_at` (stored in UTC) to the user's local date:

```typescript
const lastAutoLocalDate = utcToLocalDate(acct.last_auto_snapshot_at, userTimezone);
const todayLocalDate = getLocalTime(userTimezone).localDateStr;
if (lastAutoLocalDate === todayLocalDate) skip();
```

This prevents the UTC date comparison bug where:
- A user in California at 11 PM local (6 AM UTC next day) could get a double snapshot
- A user in Tokyo at 1 AM local (4 PM UTC previous day) could miss a day

### Fallback behavior if timezone is missing

| Scenario | Behavior |
|---|---|
| `profiles.timezone` is NULL | Falls back to `"UTC"` |
| `profiles.timezone` is invalid string | `Intl.DateTimeFormat` throws → caught, falls back to UTC |
| Client never reported timezone | UTC until next app open |
| Old user who hasn't opened since update | UTC (covered by 7-day activity gate anyway) |

### Exponential backoff

When auto-snapshot fails, the scheduler enforces increasing cooldowns:

| `fail_count` | Wait before retry |
|---|---|
| 1 | 30 minutes |
| 2 | 60 minutes |
| 3+ | Permanently blocked (requires manual reset or success) |

Formula: `BACKOFF_BASE_MINUTES × 2^(fail_count - 1)`

On success, `fail_count` and `last_auto_snapshot_fail_at` are both reset.

### Notification cooldown

Smart-notify enforces a 12-hour minimum gap between auto-snapshot notifications per user:

- `profiles.last_notification_sent_at` is checked before sending
- If less than 12h since the last notification → skip with reason `notification_cooldown`
- Prevents noisy oscillating notifications (e.g., +1, -1 every day)

## Rollout Risks

| Risk                                    | Mitigation                                          |
|-----------------------------------------|-----------------------------------------------------|
| Scheduler overloads Instagram API       | 1 account at a time, reuses existing rate limits     |
| Users get too many push notifications   | Threshold of ≥3 changes; 12h cooldown; user can disable |
| Auto snapshots exhaust daily cap        | Counts toward same 3/day cap; UI copy clarifies this |
| Failed auto snapshots cascade           | Exponential backoff (30/60/120min); resets on success|
| Dormant users waste resources           | 7-day `last_app_open_at` eligibility gate            |
| UTC scheduling hits wrong local time    | Per-user timezone from `Intl.DateTimeFormat`, fallback to UTC |
| Timezone missing for old users          | Falls back to UTC; covered by activity gate anyway   |
| Duplicate notifications for same diff   | `diffs.notification_sent` boolean idempotency guard  |
| Duplicate snapshot jobs per account     | Check for running/queued jobs before triggering      |
