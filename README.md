# StayReel

**Privacy-first Instagram follower tracker for iOS.**

Track who followed you, who unfollowed you, and who doesn't follow back — no ads, no data selling. Built and maintained by one developer.

---

## Features

- **Magic-link sign-in** — no password required, deep-link callback handled automatically
- **Instagram connection** — connect via your `sessionid` cookie, stored AES-256 encrypted in Supabase Vault
- **Resumable snapshots** — chunked job system handles 25k+ follower accounts without server timeouts
- **Automatic snapshots** — opt-in daily background snapshots with smart notifications (only fires on meaningful changes)
- **5 diff categories** — New followers, Unfollowed you, Not following you back, You don't follow back, You unfollowed
- **Growth chart** — 7-day and 30-day follower count history
- **Streak tracking** — current and longest snapshot streak
- **Weekly summary** — new and lost follower counts over the last 7 days with push notification
- **Searchable lists** — paginated, searchable, tapping opens the Instagram profile; locked behind Pro
- **Unfollow button** — unfollow directly from the Ghost list (Pro)
- **Tap the Dot mini-game** — playable during snapshot loading
- **Snapshot error guidance** — plain-English error cards for session expiry, rate limits, and challenges
- **Reconnect tracking state** — when a session expires, the app shows a calm "tracking paused" state instead of scary errors
- **Partial results UX** — large accounts (>~5,000 followers) get partial capture with clear messaging
- **Troubleshooting screen** — expandable accordion explaining every common error and how to fix it
- **Our Promise screen** — documents what the app will and won't ever do
- **Freemium / Pro** — list access gated behind RevenueCat subscription (monthly, annual, or free trial); promo codes supported; referral attribution

---

## Account Size Expectations

StayReel works best for accounts under ~5,000 followers. Larger accounts will still receive results, but scans may produce partial data due to Instagram API pagination limits. When a scan is partial:

- The dashboard shows an informational notice (not an error)
- Diff results are computed from whatever was captured
- The `is_list_complete` flag on `follower_snapshots` indicates whether the capture was full
- The `snapshot_partial_complete` analytics event fires for monitoring

---

## Tech Stack

| Layer | Choice |
|---|---|
| Mobile framework | Expo SDK 54 / React Native 0.81 |
| Navigation | Expo Router v6 (file-based) |
| Language | TypeScript |
| Data fetching | TanStack React Query v5 |
| Global state | Zustand v5 |
| Subscriptions | RevenueCat SDK v9 |
| Backend | Supabase (Auth, Postgres, Edge Functions, Vault) |
| Edge runtime | Deno (Supabase Edge Functions) |
| Build/deploy | EAS Build + EAS Submit + EAS Update (OTA) |

---

## Screens

| Screen | Route | Description |
|---|---|---|
| Sign In | `/(auth)/sign-in` | Magic-link entry; App Store review password bypass |
| Connect Instagram | `/(auth)/connect-instagram` | Session cookie entry + step-by-step CookieHelpModal |
| Magic-link callback | `/auth` | Exchanges deep-link code for a Supabase session |
| Dashboard | `/(tabs)/dashboard` | Metrics, chart, streak, snapshot button, mini-game |
| Lists | `/(tabs)/lists` | Searchable, paginated diff lists (5 types); Pro-gated |
| Settings | `/(tabs)/settings` | Account, subscription, notifications, privacy, danger zone |
| Our Promise | `/our-promise` | Product values and what will never happen |
| Troubleshooting | `/troubleshooting` | Expandable error guide with step-by-step fixes |

---

## Architecture

### Snapshot Job System

Manual captures use a **resumable chunked job** to avoid the 150-second Edge Function limit:

1. `snapshot-start` — creates a `snapshot_jobs` row, runs the first ~45 pages (~900 followers)
2. App polls `snapshot-continue` every ~2 seconds — each call runs the next chunk within a 75-second budget
3. Three phases: `followers` → `following` → `finalize`
4. `finalize` writes `follower_snapshots`, `follower_edges`, diffs, and updates the streak
5. Job cursor is persisted after every chunk — a crash or network blip is safely resumed
6. Stale/zombie jobs are cleaned up by `process-stale-jobs` (scheduled Edge Function)
7. `PAGE_LIMIT_REACHED` per-invocation is **not** a failure — the job continues on next poll

**Cooldown:** 1 snapshot per hour per account, enforced server-side.

**Max pages:** 420 pages per direction (followers/following). When the cap is reached, the job finalizes with `is_list_complete = false` and surfaces partial results.

### Auto-Snapshot Scheduler

- Users must **opt in** via Settings toggle (default: OFF, migration 029)
- `auto-snapshot-scheduler` cron runs daily, filters accounts where `auto_snapshot_enabled = true`
- Uses the user's stored timezone (falls back to UTC if missing) for local-date enforcement
- One automatic snapshot per calendar day per account
- `smart-notify` fires push notifications only when meaningful changes are detected
- smart-notify checks `auto_snapshot_enabled` as defense-in-depth before notifying
- Notification cooldown: minimum 4 hours between push notifications per user

### Reconnect/Product State Model

When an Instagram session expires or is invalidated:

1. The edge function detects the auth failure (SESSION_EXPIRED, CHALLENGE_REQUIRED, etc.)
2. `ig_accounts.reconnect_required` is set to `true`
3. A one-time push notification informs the user
4. The dashboard shows a calm "tracking paused" state — **not** an error card
5. Auto-snapshots are gated by `reconnect_required` and do not attempt to run
6. The user reconnects Instagram via Settings → the flag is cleared and tracking resumes

### Session Expiry Handling

- Client-side: `getFreshAccessToken()` proactively refreshes Supabase JWT when within 60s of expiry
- Edge functions: gateway-level 401s trigger one automatic retry with a fresh token
- If refresh fails, the user is signed out gracefully (AuthGuard redirects to sign-in)
- Instagram session expiry is a separate flow — handled by the reconnect state above

### Edge Functions

| Function | Purpose |
|---|---|
| `connect-instagram` | Validates session cookie, stores in Vault, upserts `ig_accounts` |
| `snapshot-start` | Creates job, runs first follower chunk |
| `snapshot-continue` | Runs next chunk for an in-progress job |
| `process-stale-jobs` | Scheduled cleanup — fails zombie jobs older than timeout thresholds |
| `auto-snapshot-scheduler` | Cron — starts daily auto-snapshots for opted-in accounts |
| `smart-notify` | Evaluates diff significance and sends push for meaningful changes |
| `diffs-latest` | Returns dashboard metrics + `next_snapshot_allowed_at` |
| `list-users` | Paginated follower lists (5 types) |
| `snapshot-history` | Historical counts for growth chart |
| `send-notification` | Service-role — sends push notifications (weekly summary, snapshot ready) |
| `weekly-summary-notify` | Scheduled — sends weekly follower summary push |
| `rc-webhook` | RevenueCat webhook receiver — syncs subscription status to `profiles` |
| `redeem-promo` | Validates and applies a promo code, grants `promo_until` access |
| `set-referral` | Records referral attribution on first use |
| `unfollow-user` | Proxy unfollow action through the stored session cookie |
| `capture-snapshot` | Legacy single-call capture (disabled — returns 410) |
| `status` | Health check |
| `admin-reset-quota` | **Dev only** — resets quota / clears snapshot data |

### Database Tables

| Table | Purpose |
|---|---|
| `profiles` | One row per auth user; holds subscription status, promo_until, school, referral |
| `ig_accounts` | Connected Instagram accounts; holds Vault secret ID, streak, `auto_snapshot_enabled`, `reconnect_required`, timezone |
| `follower_snapshots` | Per-capture counts; `is_list_complete` flag; raw JSON kept 30 days then nulled |
| `follower_edges` | Normalised per-follower rows, indexed for set-diff queries |
| `diffs` | Pre-computed diff between consecutive snapshots; `notification_sent` flag |
| `snapshot_jobs` | Resumable job state (cursor, phase, accumulated JSON, lock, heartbeat) |
| `snapshot_quota` | Per-user daily quota counter |
| `audit_events` | Immutable event log |
| `user_settings` | Per-user notification preferences |
| `funnel_events` | Analytics event log |
| `promo_codes` | Promo code definitions (quota, expiry, active flag) |

Migrations 001–029 applied to production. Row-Level Security is enabled on every table. Edge Functions use the service-role `adminClient` internally.

---

## Project Structure

```
app/
  _layout.tsx              Root layout (providers, auth guard, deep-link handler)
  auth.tsx                 Magic-link callback screen
  index.tsx                Redirect splash
  our-promise.tsx          Product values screen
  troubleshooting.tsx      Error guide screen
  (auth)/
    sign-in.tsx
    connect-instagram.tsx
  (tabs)/
    _layout.tsx            Tab bar layout
    dashboard.tsx
    lists.tsx
    settings.tsx

components/
  BannerAdView.tsx         Placeholder (ads removed — renders nothing)
  CookieHelpModal.tsx      Step-by-step Instagram cookie guide
  DashboardCard.tsx        Stat card with left-accent border and icon
  GrowthChart.tsx          Follower count line chart (7d / 30d toggle)
  LockedUserRow.tsx        Blurred row shown when lists are Pro-gated
  PaywallModal.tsx         RevenueCat paywall sheet
  PromoCodeModal.tsx       Promo code redemption sheet
  ReferralCodeModal.tsx    Referral code entry sheet
  SchoolPickerModal.tsx    School attribution picker
  SearchBar.tsx
  SnapshotErrorCard.tsx    Inline snapshot error with user-friendly guidance
  StatsRow.tsx             Followers / Following / Friends pill row
  StreakBadge.tsx          Current and longest streak display
  TapTheDotGameModal.tsx   Mini-game played during snapshot loading
  TermsAcceptanceModal.tsx Terms of Service acceptance gate
  UserListItem.tsx         Avatar + @username row (with optional unfollow button)
  WeeklySummaryCard.tsx    7-day new/lost follower summary

hooks/
  useAutoSnapshotSetting.ts    Read/toggle auto-snapshot opt-in state
  useDashboard.ts              React Query: fetch diffs-latest metrics
  useListData.ts               React Query: infinite-paginated list
  useSnapshotCapture.ts        Manages start → poll → done job flow; exposes live progress
  useSnapshotHistory.ts        React Query: historical counts for GrowthChart
  useSnapshotReconciliation.ts Reconciles in-progress jobs on app foreground/resume
  useNotifications.ts          Push token registration + notification tap handler
  useNotificationSettings.ts   Read/write notification preferences (user_settings)
  useNetwork.ts                NetInfo online/offline state
  useReferralPrompt.ts         Decides when to show the referral entry modal
  useReviewPrompt.ts           Decides when to request an App Store review
  useSchoolPrompt.ts           Decides when to show the school picker modal
  useSafeAsync.ts              Cancellation-safe async wrapper for unmounted components
  useTapDotHighScore.ts        AsyncStorage persistence for mini-game high score
  useUnfollowUser.ts           Mutation: proxy unfollow via edge function

lib/
  analytics.ts             Lightweight funnel event logger (Supabase)
  colors.ts                Design token palette
  featureFlags.ts          Centralized feature flags (ENABLE_POST_CONNECT_ONBOARDING)
  fetchWithTimeout.ts      fetch() wrapper with configurable timeout + abort
  limitsCopy.ts            User-facing copy for account-size expectations
  notifications.ts         Expo push token registration helpers
  offlineStorage.ts        AsyncStorage helpers for offline-safe data
  queryClient.ts           TanStack Query client config
  revenueCat.ts            RevenueCat SDK v9 init, paywall, customer center helpers
  schools.ts               School list + label lookup
  snapshotJobStore.ts      Persisted job ID cache (AsyncStorage) for resume on cold start
  supabase.ts              Supabase client singleton + deep-link handler

store/
  authStore.ts             Zustand: session, user, igAccountId, pending routes
  subscriptionStore.ts     Zustand: isPro, effectivePlan(), promo, RC listener, hydrate

supabase/
  migrations/              001–029, all applied to production
  functions/
    _shared/               auth, cors, errors, instagram, rate_limit, snapshotJob,
                           vault, notify, diff, diff_writer, push
    connect-instagram/
    snapshot-start/
    snapshot-continue/
    process-stale-jobs/
    auto-snapshot-scheduler/
    smart-notify/
    diffs-latest/
    list-users/
    snapshot-history/
    send-notification/
    weekly-summary-notify/
    rc-webhook/
    redeem-promo/
    set-referral/
    unfollow-user/
    capture-snapshot/      (disabled — returns 410)
    status/
    admin-reset-quota/
  templates/
    magic-link.html
    confirmation.html
```

---

## Quick Start

### Prerequisites

- Node.js 20+
- Expo CLI: `npm i -g expo-cli`
- EAS CLI: `npm i -g eas-cli`
- Supabase project with migrations applied

### Install and run

```bash
npm install
npx expo start          # Metro bundler (JS only — RC/notifications need a native build)
npx expo run:ios        # iOS simulator with native modules
npx expo run:android    # Android emulator with native modules
```

### EAS Build (physical device / App Store submission)

```bash
eas login
eas build --profile production --platform ios
eas submit
```

### OTA Update (JS-only changes)

```bash
eas update --branch production --message "your message"
```

---

## Supabase Setup

```bash
npm i -g supabase
supabase link --project-ref <your-project-ref>
supabase db push                              # apply migrations 001–029
supabase functions deploy --no-verify-jwt    # deploy all Edge Functions
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<key>
```

### Cron / Scheduler Setup

The following scheduled edge functions must be configured via the Supabase Dashboard (Database → Extensions → pg_cron) or via `supabase/config.toml`:

| Schedule | Function | Purpose |
|---|---|---|
| Every 6 hours | `auto-snapshot-scheduler` | Starts daily auto-snapshots for opted-in accounts |
| Every 10 minutes | `process-stale-jobs` | Cleans up zombie/stale snapshot jobs |
| Every Monday 9:00 UTC | `weekly-summary-notify` | Sends weekly follower summary push |

---

## Environment Variables

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `EXPO_PUBLIC_RC_API_KEY_IOS` | RevenueCat iOS API key |
| `EXPO_PUBLIC_DEV_EMAIL` | App Store review test email |
| `EXPO_PUBLIC_DEV_PASSWORD` | App Store review test password |

`EXPO_PUBLIC_DEV_EMAIL` and `EXPO_PUBLIC_DEV_PASSWORD` are stored as EAS secrets and embedded at build time. Entering the dev email on the sign-in screen reveals a password field — no magic link is sent. Used by App Store reviewers.

---

## Operational Behavior

### Auto-Snapshot Opt-In

- Default: **OFF** (migration 029 resets all existing accounts to false)
- User enables via Settings → "Automatic snapshots" toggle
- When toggling on, the subtitle warns: "This may increase activity on your Instagram account"
- Analytics events: `auto_snapshots_enabled_on` / `auto_snapshots_enabled_off`
- Scheduler skips accounts where `auto_snapshot_enabled = false`
- `smart-notify` double-checks the flag before sending any notification

### Notification Cooldown

- Minimum 4 hours between push notifications per user (checked via `profiles.last_notification_sent_at`)
- If a notification was sent within 4h, smart-notify returns `skipped: cooldown_active`
- Idempotency: `diffs.notification_sent` flag prevents duplicate notifications for the same diff

### Max Pages & Partial Results

- `MAX_PAGES = 420` per direction (followers/following) — tuned to support accounts up to ~8,400 followers
- `MAX_PAGES_PER_INVOCATION = 45` (20 for first snapshot) — stays within edge function time budget
- When the page cap is hit, `PAGE_LIMIT_REACHED` is emitted — this is **not** a failure
- The job continues normally; at finalize, `is_list_complete` is computed from remaining cursors
- If cursors remain, `is_list_complete = false` and the dashboard shows an amber partial-results notice
- Analytics: `snapshot_partial_complete` event fires for partial captures
- Server logs: `[job X] partial capture: followers_cursor=... following_cursor=...`

### Terms & Conditions Persistence

- Terms acceptance check runs **in parallel** with the IG account query at boot (Promise.all)
- This eliminates a race condition where the terms modal could briefly flash after acceptance

### Post-Connect Onboarding

- School picker and referral code modals are **disabled** via `ENABLE_POST_CONNECT_ONBOARDING = false`
- The underlying hooks, DB columns, and Settings entries remain intact
- Re-enable by flipping the flag in `lib/featureFlags.ts`

---

## Troubleshooting

### Reconnect Required

If a user's Instagram session expires, the app shows "Tracking paused" and prompts them to reconnect. Auto-snapshots stop running until the session is restored.

### Partial / Incomplete Results

Accounts with >~5,000 followers may receive partial scan results. The dashboard shows an informational amber notice. This is expected behavior, not an error.

### Auto Snapshots Not Running

Check:
1. User has opted in (Settings → "Automatic snapshots" toggle is ON)
2. `ig_accounts.auto_snapshot_enabled = true` in DB
3. Account status is `active` and `reconnect_required = false`
4. `auto_snapshot_fail_count` hasn't exceeded threshold
5. Cron job is configured and running (check pg_cron logs)

### Timezone Missing / UTC Fallback

If `ig_accounts.timezone` is null, the scheduler uses UTC for daily-limit enforcement. The app records the user's timezone on first app open and on each foreground event.

### Terms Prompt Flashing

Fixed in v1.5.4 — terms hydration now runs in parallel with IG account check, eliminating the race condition.

---

## Key Design Decisions

- **No passwords stored** — only the Instagram `sessionid` cookie, AES-256 encrypted via Supabase Vault.
- **Resumable jobs** — chunked pagination survives the 150-second Edge Function limit; cursor is persisted in `snapshot_jobs`.
- **1-hour cooldown** — one manual snapshot per hour per account to protect the user's Instagram account.
- **ig_id matching** — users who rename their Instagram handle are not counted as lost + new followers.
- **30-day TTL on raw lists** — raw follower JSON is nulled by pg_cron after 30 days; diff results are kept indefinitely.
- **RC is source of truth** — subscription status is determined by RevenueCat entitlement check at launch, with Supabase DB as fallback. The RC webhook keeps `profiles.subscription_status` in sync for server-side gating.
- **Promo codes** — server-managed via `redeem-promo`; grants `promo_until` timestamp independent of RC.
- **Mini-game engagement** — the Tap the Dot game is shown during snapshot loading.
- **OTA updates** — JS-only fixes ship via `eas update` to the `production` channel without a full App Store review cycle.
- **Auto-snapshot opt-in** — users must explicitly enable automatic snapshots; this protects trust and reduces unwanted IG activity.
- **Feature flags** — onboarding flows can be toggled without removing code (see `lib/featureFlags.ts`).

---

## Known Limitations

- Instagram's private API may throttle or break at any time; `big_list` mode returns ~19 users/page on many accounts.
- No automated CI/CD pipeline (tests run locally).
- `admin-reset-quota` is still deployed to production — should be removed or key-guarded before wide release.

---

## License

MIT
