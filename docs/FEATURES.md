# StayReel — Feature Reference

A complete inventory of every feature in the app, organized by area.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Instagram Connection](#2-instagram-connection)
3. [Snapshot System](#3-snapshot-system)
4. [Dashboard](#4-dashboard)
5. [Follower Lists](#5-follower-lists)
6. [Growth Chart](#6-growth-chart)
7. [Weekly Summary](#7-weekly-summary)
8. [Streak Tracking](#8-streak-tracking)
9. [Unfollow Action](#9-unfollow-action)
10. [Subscription (Pro)](#10-subscription-pro)
11. [Ads](#11-ads)
12. [Push Notifications](#12-push-notifications)
13. [Settings](#13-settings)
14. [School Attribution](#14-school-attribution)
15. [Tap the Dot Mini-Game](#15-tap-the-dot-mini-game)
16. [Our Promise Page](#16-our-promise-page)
17. [Troubleshooting Guide](#17-troubleshooting-guide)
18. [Security & Privacy](#18-security--privacy)
19. [Rate Limiting & Account Safety](#19-rate-limiting--account-safety)
20. [Backend Architecture](#20-backend-architecture)

---

## 1. Authentication

**Magic-link sign-in (passwordless)**
- User enters their email address.
- Supabase sends a magic-link email using a custom branded template.
- Tapping the link deep-links back into the app via the `stayreel://` scheme and establishes a session automatically.
- No password required for regular users — removes friction at sign-up.

**App Store reviewer bypass**
- The designated test email triggers a password field instead of sending a magic link.
- Allows Apple reviewers to sign in immediately without access to an email inbox.
- Works in production builds only when `EXPO_PUBLIC_DEV_EMAIL` and `EXPO_PUBLIC_DEV_PASSWORD` are set.

**Session persistence**
- Sessions are persisted to AsyncStorage via Supabase JS v2.
- On reopen, the session is restored silently without requiring re-authentication.
- Proactive token refresh: access token is refreshed automatically if it expires within 60 seconds, preventing edge function 401s when the device was backgrounded for a long time.

**Auth guard**
- A root-level `AuthGuard` redirects unauthenticated users to the sign-in screen.
- Bootstraps profile + IG account data on first load.
- 15-second safety timeout prevents infinite loading if a network call hangs.

---

## 2. Instagram Connection

**WebView-based login**
- A full-screen WebView opens Instagram's mobile web login.
- The user logs in to their real Instagram account inside the app.
- After login, the session cookie is extracted and securely stored in Supabase Vault (encrypted).

**Automatic account detection**
- After login, the `connect-instagram` edge function reads the session cookie to fetch the user's Instagram user ID, username, and follower/following counts.
- Creates an `ig_accounts` row linked to the user's profile.

**Multi-session isolation**
- Each Instagram account is stored separately with its own vault secret.
- The session cookie never leaves the server — only the encrypted vault reference is stored client-side.

**Disconnect**
- Soft-deletes the `ig_accounts` row (sets `deleted_at` and `status = 'disconnected'`).
- Session history is preserved — no data is lost.
- The user can reconnect at any time.

---

## 3. Snapshot System

**What a snapshot is**
- A full crawl of the user's followers list and following list fetched directly from Instagram's private API.
- Stored as a complete edge graph (every follower/followee at that moment in time).

**Resumable job architecture**
- Snapshots are broken into chunks and processed through a job queue (`snapshot_jobs` table).
- `snapshot-start` initiates the job and runs the first chunk.
- `snapshot-continue` is polled by the client every 2 seconds to advance the job.
- If the app is backgrounded mid-snapshot, the job can be resumed.
- Up to 8 automatic retries with exponential backoff on transient poll failures.

**Live progress display**
- The dashboard shows a live progress card while a snapshot runs:
  - Current phase: `Followers X of ~Y`, `Following Z so far`, or `Saving…`
  - Pages fetched count.
  - "Following list cached today" notice when the following crawl is skipped for safety.
- The capture button shows an inline progress indicator with a percentage.

**Following list caching**
- The following list is only re-fetched once per day, regardless of how many snapshots are taken.
- Reduces Instagram API calls and lowers the risk of rate-limiting.
- The UI notifies the user when cached data is being used.

**Diff computation**
- After each snapshot, a diff is computed between the two most recent snapshots.
- Produces: new followers, lost followers, you unfollowed, not following back, you don't follow back, net follower change.
- Diff computation is pure and deterministic, run server-side.

**Error handling**
- Typed error codes: `IG_SESSION_INVALID`, `IG_CHALLENGE_REQUIRED`, `IG_RATE_LIMITED`, `SNAPSHOT_LIMIT`, `UNAUTHORIZED`, `INTERNAL_ERROR`.
- Each error type shown with a contextual `SnapshotErrorCard` on the dashboard.
- Instagram challenge errors link the user to open Instagram and resolve the challenge manually.
- Session errors prompt reconnection via Settings.

**Audit log**
- Every snapshot start, completion, failure, and rate-limit hit is written to `audit_events` with IP address, timestamp, and metadata.

---

## 4. Dashboard

**Snapshot button**
- Prominent "Take Snapshot" CTA button in the header.
- Disabled with a live countdown timer when the hourly cooldown is active.
- Disabled with a daily cap message when 3 snapshots have been taken in the past 24 hours.
- Shows a contextual pre-snapshot alert explaining the wait time and introducing the mini-game.

**Cooldown display**
- Hourly cooldown: `Next snapshot available in HH:MM:SS` (live countdown).
- Daily cap: `Daily limit reached (X of 3 today). Resets in HH:MM:SS`.
- Countdown ticks every second in real time.

**Net follower change card**
- Displays net change since last snapshot: `+12` or `-3`.
- Color-coded green (gain) or red (loss).
- Breakdown line: `+X new · −Y lost`.

**Stats row**
- Follower count, following count, and mutual connections — all from the latest snapshot.

**Diff metric cards**
- 5 tappable cards:
  - 🟢 New followers
  - 🔴 Unfollowed you
  - 🟡 Not following you back (ghost followers)
  - 🔵 You don't follow back
  - 🟣 You unfollowed
- Each card shows the count and opens the corresponding list on tap.

**Pull-to-refresh**
- Manual pull-to-refresh reloads dashboard data.
- Background React Query refetches (post-snapshot) do not trigger the scroll-freeze bug — handled with a separate `manualRefreshing` flag.

**Last capture timestamp**
- Subtitle below the dashboard title shows the date and time of the last snapshot.

---

## 5. Follower Lists

**Five list types**
| Tab | Contents |
|-----|----------|
| New | Accounts that followed you since the last snapshot |
| Lost | Accounts that unfollowed you |
| Ghost | Accounts you follow but do not follow you back |
| Don't follow | Accounts that follow you but you don't follow back |
| Unfollowed | Accounts you unfollowed since the last snapshot |

**Search**
- Real-time username search filters the active list client-side.
- Search state resets when switching tabs.

**Infinite scroll / pagination**
- Lists are paginated via `useInfiniteQuery`.
- New pages load automatically when the user scrolls to 30% from the bottom.

**Deep-link navigation from dashboard**
- Tapping a dashboard metric card sets a `pendingListType` in the auth store.
- The Lists tab reads this and jumps directly to the correct tab, even if already mounted.

**User list item**
- Displays: username, Instagram profile URL (opens in browser).
- Includes unfollow action button for ghost-follower list items.

---

## 6. Growth Chart

**Follower count over time**
- SVG line chart rendered with `react-native-svg`.
- Smooth cubic bezier curve with a gradient fill underneath.
- Data points for each snapshot; hover/press shows exact count and date.

**7-day / 30-day toggle**
- Switch between 7-day and 30-day windows with a pill toggle.
- Min and max follower counts labeled on the Y-axis.
- Date labels on the X-axis.

**Loading and empty states**
- Shows an activity indicator while data loads.
- Shows a placeholder message if fewer than 2 snapshots exist.

---

## 7. Weekly Summary

- Appears automatically when there are at least 2 complete diffs within the past 7 days.
- Shows: total new followers, total lost followers, and net change for the week.
- Color-coded values (green for gains, red for losses).

---

## 8. Streak Tracking

- A streak increments each day at least one snapshot is taken and the follower count does not decrease.
- Displayed as a 🔥 badge with the current streak in days.
- Current streak and personal-best (longest) streak are both tracked.
- Only shown when the streak is 1 or more days.

---

## 9. Unfollow Action

**One-tap unfollow from the app**
- Available on the "Not following you back" (ghost follower) list.
- Calls the `unfollow-user` edge function, which uses the stored Instagram session to call the Instagram unfollow API directly.
- Optimistic UI: the button immediately shows a "Done" checkmark while the request is in-flight.
- Errors (rate limit, session expired) are surfaced inline.

**Safety**
- The Instagram session cookie used for the unfollow is retrieved from Supabase Vault at call time — never stored in the client app.
- Rate-limit and session-expiry errors automatically update the `ig_accounts` status in the database.

---

## 10. Subscription (Pro)

**Plans**
- Monthly subscription
- Annual subscription
- Lifetime one-time purchase

**Free tier**
- Snapshots are unlimited for all users (rate-limited to 3/day, 1/hour for account safety).
- Lists show the first 10 results; remaining rows are locked behind a soft upgrade CTA.
- Free snapshot count is still tracked in Supabase (`free_snapshots_used`) for analytics.

**RevenueCat integration**
- SDK v9 (`react-native-purchases` + `react-native-purchases-ui`).
- Native paywall UI rendered via `RevenueCatUI.Paywall` — Apple-compliant, includes price, duration, trial details, and auto-renewal disclosure.
- Real-time `CustomerInfo` listener updates `isPro` immediately after purchase, restore, or cancellation without requiring an app restart.
- `ENTITLEMENT_ID = 'StayReel Pro'` — the single source of truth for gate checks.

**Purchase flow gates**
- Client-side: `isPro` in the subscription store controls list visibility (free users see 10 items + locked rows).
- Server-side: `list-users` edge function truncates results to `FREE_PREVIEW_LIMIT` for non-pro users.

**Restore purchases**
- Settings → Restore Purchases contacts RevenueCat and re-hydrates entitlement.
- Shows confirmation alert if a subscription is found.

**Subscription management**
- Pro users: Settings → Manage subscription opens the native RevenueCat Customer Center (change plan, view history, contact support).
- Pro users: Settings → Cancel subscription deep-links to the App Store subscription management page.

**Webhook sync**
- RevenueCat webhook (`rc-webhook` edge function) keeps `profiles.subscription_status` and `profiles.subscription_expires_at` in sync with RevenueCat events (purchase, renewal, cancellation, expiry).

**Environment handling**
- iOS Simulator: shows "Purchases Not Supported Here" with sandbox testing instructions instead of a generic error.
- Android: skipped entirely (iOS-only app).

---

## 11. Ads

**Banner ads**
- Google Mobile Ads banner rendered at the top of the Dashboard and Lists screens.
- GDPR/ATT consent handled via `ConsentModal` before ads are shown.

**Interstitial ads**
- Shown every 3 list opens (`INTERSTITIAL_EVERY_N_OPENS = 3`).
- Frequency cap persisted to AsyncStorage so it survives app restarts.

**Remove ads (rewarded)**
- Users can watch a rewarded video ad to remove all ads for 7 days — free.
- Available from Settings → "Remove ads for 7 days".
- Expiry timestamp stored in AsyncStorage; ads resume automatically after 7 days.
- Settings shows a countdown of when ads will return.

---

## 12. Push Notifications

**Expo Push Notifications**
- Push token registered on launch and stored in `profiles.push_token`.
- Token is refreshed on each app launch to stay current.
- Token is deregistered (nulled) on sign-out.

**Notification types**

| Notification | Trigger | Default |
|---|---|---|
| Snapshot ready | Snapshot job completes | On |
| Weekly summary | Weekly cron | On |
| Unfollow alerts | Included in weekly summary | On |
| Session expiry | Coming soon | — |

**User controls**
- Each notification type has an individual on/off toggle in Settings.
- Preferences stored in `user_settings` table, synced in real time.

**Foreground suppression**
- "Snapshot ready" push is suppressed while the user is watching the live progress bar in the app, to avoid a redundant notification.
- Suppression window extends 15 seconds after the poll loop ends to catch late-arriving server pushes.

---

## 13. Settings

**Account section**
- School attribution (see §14)
- Disconnect Instagram (soft-delete, history preserved)

**Subscription section**
- Current plan display (Free / Free Trial / Pro)
- Renewal or trial end date (Pro users)
- Upgrade to Pro (free users)
- Restore Purchases (free users)
- Manage subscription via RevenueCat Customer Center (Pro users)
- Cancel subscription shortcut (Pro users)

**Notifications section**
- Per-type toggles for all notification categories

**Ads section**
- Remove ads for 7 days via rewarded video
- Ads-removed countdown display

**Privacy section**
- Privacy Policy (opens browser)
- Terms of Service (opens browser)

**Danger zone**
- Delete all my data — permanently removes snapshots and account (confirmed via two-step alert)
- Sign out

**About section**
- Our Promise page
- Troubleshooting guide

---

## 14. School Attribution

**One-time school picker**
- Shown once to new users after their first snapshot.
- Full-screen modal with a list of supported schools.
- Selection is persisted to `profiles.school` and `profiles.school_selected_at`.
- "Don't ask again" option permanently dismisses the prompt.

**Settings integration**
- Current school displayed in Settings with a tap-to-change picker.
- School selection errors (DB failures) shown inline with an alert; modal stays open for retry.

---

## 15. Tap the Dot Mini-Game

**Purpose**
- Keeps users engaged while waiting for a snapshot to finish (which can take several minutes due to rate-limiting).
- Launched via a "Play while loading" card that appears inside the snapshot progress area.

**Gameplay**
- A dot appears at a random position on screen.
- Tap it as many times as possible in 30 seconds.
- The dot moves to a new random position after each tap.
- Dot moves faster as the game progresses (difficulty scales).
- Score and timer displayed live.

**High score tracking**
- Personal best score persisted to AsyncStorage via `useTapDotHighScore`.
- New high score toast shown immediately when beaten.
- Score displayed at end of game alongside the personal best.

**Snapshot status integration**
- The modal shows a live status pill: `Refreshing…` → `Done! ✓` or `Failed`.
- On snapshot completion, an in-modal toast announces it.
- On snapshot failure, an error toast explains what went wrong.
- User can close the modal at any time; the snapshot continues in the background.

---

## 16. Our Promise Page

A dedicated screen (accessible from Settings → About) outlining:

- **You are not the product** — no dark patterns, rate limits exist to protect the user's Instagram account, not to push paywalls.
- **Your data stays yours** — session data and follower lists are never sold or shared.
- **Indie-built** — one developer, no investor pressure, no growth-at-any-cost decisions.
- **Fair pricing** — if paid tiers exist, they cover real costs, not emotional extraction.

Includes a feedback/contact section linking to email and Instagram for bugs and feature requests.

---

## 17. Troubleshooting Guide

An in-app help page with expandable accordion sections covering:

| Error | Cause | Resolution |
|---|---|---|
| Session expired / Invalid session | Instagram login inside the app expired | Disconnect and reconnect Instagram |
| Instagram needs verification / Challenge required | Instagram flagged unusual activity | Complete the security challenge inside the Instagram app |
| Rate limited / Too many requests | Instagram throttled the account | Wait 1–6 hours; do not retry repeatedly |
| StayReel session expired | Supabase auth token expired | Sign out and sign back in |
| Snapshot stuck | Long-running job or network timeout | Wait or force a fresh start |

---

## 18. Security & Privacy

- **No passwords stored** — passwordless authentication only (magic link).
- **Encrypted Instagram sessions** — session cookies stored in Supabase Vault, AES-256 encrypted at rest. Never returned to the client.
- **Row-Level Security** — every Supabase table has RLS policies. Users can only read and write their own rows.
- **Service-role only writes** — `follower_snapshots`, `follower_edges`, `diffs`, and `audit_events` cannot be written directly by authenticated users. All writes go through edge functions running under the service role.
- **Token refresh** — access tokens are proactively refreshed before expiry to prevent stale JWTs from reaching edge functions.
- **Soft deletes** — Instagram accounts and user data are soft-deleted first; hard deletes happen on a 30-day cron job.

---

## 19. Rate Limiting & Account Safety

The rate-limiting system is designed primarily to protect the user's Instagram account from being flagged or banned.

| Limit | Value | Purpose |
|---|---|---|
| Hourly cooldown | 1 hour between snapshots | Prevents rapid repeated crawls |
| Daily cap | 3 snapshots per 24-hour rolling window | Reduces total API call volume per account |
| Following cache | Once per day | Halves the number of Instagram API pages fetched |
| Exponential backoff | 3s, 6s, 12s… on poll failures | Avoids hammering Instagram during transient errors |
| IG rate-limit extension | +1 hour cooldown added when Instagram returns 429 | Prevents the user from immediately retrying after a throttle |

The cooldown reason is communicated to the client (`cooldown_reason: "hourly" | "daily_cap"`) so the UI can show an accurate contextual message instead of a generic timer.

---

## 20. Backend Architecture

| Component | Technology |
|---|---|
| Auth | Supabase Auth (magic link + JWT) |
| Database | Supabase PostgreSQL with RLS |
| Secret storage | Supabase Vault (encrypted key-value) |
| Edge functions | Deno (TypeScript), deployed to Supabase |
| Push notifications | Expo Push Notification Service |
| Subscription billing | RevenueCat SDK v9 + webhook sync |
| Client state | Zustand (auth, subscription, ads) |
| Server state / caching | TanStack Query (React Query) |
| Ads | Google Mobile Ads (AdMob) |

**Edge functions**

| Function | Purpose |
|---|---|
| `connect-instagram` | Validates session cookie, creates `ig_accounts` row |
| `snapshot-start` | Auth + rate-limit check, starts a snapshot job |
| `snapshot-continue` | Advances a running snapshot job by one chunk |
| `diffs-latest` | Returns full dashboard data for the latest diff |
| `list-users` | Returns paginated follower list for a given diff type |
| `snapshot-history` | Returns follower count history for the growth chart |
| `unfollow-user` | Calls Instagram unfollow API using the stored session |
| `status` | Health check endpoint |
| `rc-webhook` | Handles RevenueCat webhook events to sync subscription status |
| `admin-reset-quota` | Admin tool to reset snapshot quota for a user |
