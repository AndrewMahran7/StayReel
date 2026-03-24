# StayReel  Progress Overview

## What It Is
StayReel is an Instagram follower-tracking app. Users connect their Instagram account via a session-cookie flow. The app periodically snapshots their followers and following lists, computes diffs, and surfaces metrics like new followers, unfollowers, and reciprocity (who doesn't follow back).

**Stack:** Expo SDK 54 (React Native, old arch)  Supabase (Postgres + Edge Functions + Vault)  iOS (TestFlight) + Android emulator

---

## Architecture

### Database (Supabase — all 16 migrations applied)

| Table | Purpose |
|---|---|
| `profiles` | One row per auth user (auto-created by trigger on `auth.users`). Now also stores `push_token`, `rc_customer_id`, `subscription_status`, `subscription_expires_at`, `free_snapshots_used`, `free_snapshot_limit`, `school`, `school_do_not_ask`, `referral_source` |
| `ig_accounts` | Connected Instagram accounts (vault_secret_id, status, username, streak) |
| `follower_snapshots` | Each capture: raw `followers_json`, `following_json` arrays + counts |
| `follower_edges` | Normalised per-follower rows (indexed for set-diff queries) |
| `diffs` | Pre-computed diff between consecutive snapshots (5 list columns + counts) |
| `snapshot_quota` | Per-user daily quota counter (legacy; superseded by 1-hour cooldown) |
| `snapshot_jobs` | Resumable chunked job state (cursor, phase, accumulated JSON) |
| `audit_events` | Immutable log of every significant event |
| `user_settings` | Per-user preferences (consent, ads removed, `notify_weekly_summary`, `notify_refresh_complete`) |

Row Level Security is enabled on every table. All Edge Functions use the service-role `adminClient` internally.

### Edge Functions

| Function | Method | Purpose |
|---|---|---|
| `connect-instagram` | POST | Receives session cookie, stores in Vault, upserts `ig_accounts` + `profiles` |
| `snapshot-start` | POST | Creates a `snapshot_jobs` row and runs the first follower chunk. Enforces free-snapshot limit for non-pro users. |
| `snapshot-continue` | POST | Runs the next chunk for a running job (polled every ~1 s by the app) |
| `capture-snapshot` | POST | Legacy single-call capture (used by cron / onboarding) |
| `diffs-latest` | GET | Dashboard metrics + `next_snapshot_allowed_at` (1-hour cooldown) |
| `list-users` | GET | Paginated follower lists (5 types) |
| `snapshot-history` | GET | Historical snapshot counts for growth chart |
| `status` | GET | Health check |
| `admin-reset-quota` | POST | **Dev only** — resets quota and optionally clears snapshot data |
| `send-notification` | POST | Generic push notification sender |
| `weekly-summary-notify` | POST | Cron-triggered weekly follower summary push |
| `rc-webhook` | POST | RevenueCat subscription lifecycle webhook |
| `unfollow-user` | POST | Unfollow a user on Instagram |

### Shared modules (`supabase/functions/_shared/`)

| Module | Purpose |
|---|---|
| `instagram.ts` | Instagram private API: `fetchUserList`, `fetchEdgeListChunked`, failure catalogue |
| `snapshotJob.ts` | `runSnapshotChunk` — core worker for the resumable job system + completion push (dedup via `completed_notified_at`) |
| `push.ts` | Expo Push API helper for sending push notifications |
| `notify.ts` | Email (Resend) + push multiplexer |
| `rate_limit.ts` | `checkAndEnforce24hLimit` (now 1-hour cooldown) |
| `diff.ts` / `diff_writer.ts` | Compute and persist follower diffs |
| `auth.ts` / `vault.ts` / `errors.ts` / `cors.ts` / `audit.ts` | Utilities |

### Mobile App

```
app/
  auth.tsx                deep-link handler: exchanges magic-link code for session
  (auth)/
    sign-in.tsx           magic link + App Store review password bypass
    connect-instagram.tsx  session cookie entry + CookieHelpModal
  (tabs)/
    dashboard.tsx         5 metric cards, net follower callout, growth chart,
                           streak badge, weekly summary, manual refresh with
                           live progress card + "Tap the Dot" mini-game,
                           paywall gate, school attribution prompt
    lists.tsx             searchable, paginated user list (5 tab types)
    settings.tsx          disconnect IG, delete data, remove-ads, consent,
                           subscription section, notification toggles, school picker

components/
  DashboardCard.tsx       stat card (left-accent border, icon, count, chevron)
  UserListItem.tsx        avatar (unavatar.io) + @username
  BannerAdView.tsx        AdMob banner (respects consent + remove-ads state)
  ConsentModal.tsx        GDPR/ATT consent sheet
  RemoveAdsSheet.tsx      remove-ads reward flow
  PaywallModal.tsx        RevenueCat paywall with yearly/monthly plans
  SchoolPickerModal.tsx   school / university picker for ambassador tracking
  SearchBar.tsx
  GrowthChart.tsx         follower count line chart (7d / 30d toggle)
  StatsRow.tsx            Followers / Following / Friends pill row
  StreakBadge.tsx         current + longest streak
  WeeklySummaryCard.tsx   7-day new/lost summary
  TapTheDotGameModal.tsx  "Tap the Dot" mini-game shown during snapshot loading
  SnapshotErrorCard.tsx   error display for failed snapshots

hooks/
  useDashboard.ts         fetches diffs-latest, maps to DiffSummary
  useListData.ts          infinite query against list-users
  useSnapshotCapture.ts   start job → poll snapshot-continue → done
  useSnapshotHistory.ts   historical counts for GrowthChart
  useTapDotHighScore.ts   AsyncStorage high-score for mini-game
  useInterstitialAd.ts    frequency-capped interstitial
  useRewardedAd.ts        rewarded ad for remove-ads flow
  useNotifications.ts     boot-time token re-registration + tap handling
  useNotificationSettings.ts  per-toggle notification prefs (React Query)
  useSchoolPrompt.ts      auto-prompt logic for school picker
  useUnfollowUser.ts      unfollow UI action

lib/
  notifications.ts        push registration, foreground handler, token management
  revenueCat.ts           RevenueCat SDK init, entitlement, offerings, purchases
  schools.ts              SCHOOLS array + schoolLabel() helper

store/
  authStore.ts            user session + igAccountId (Zustand + AsyncStorage)
  adStore.ts              consent state, ads-removed expiry, list-open counter
  subscriptionStore.ts    subscription status + free-snapshot tracking (Zustand)
```

---

## What Is Working

### Auth & Onboarding
-  Magic-link sign-in
-  Deep-link `stayreel://auth?code=` handled by `app/auth.tsx` (no Unmatched Route)
-  App Store review bypass: enter `dev@stayreel.test`  password field appears  password sign-in (no email sent)
-  Session cookie entry + CookieHelpModal step-by-step guide
-  Session cookie stored encrypted in Supabase Vault
-  `profiles` row auto-created (backfill migration handles pre-existing users)

### Snapshot Capture  Resumable Job System
-  Accounts with 25k+ followers handled via chunked jobs (no 150 s timeout)
-  `snapshot-start` creates job row, runs first ~45 pages (~900 followers)
-  App polls `snapshot-continue` every 1 s; each call runs next chunk within 75 s budget
-  Cursor persisted in `snapshot_jobs` after every chunk  crash-safe
-  Three phases: `followers`  `following`  `finalize`
-  Auto-advance: if time remains after a phase completes, next phase starts in same call
-  `finalize` writes `follower_snapshots`, `follower_edges`, diffs, updates streak
-  Fatal Instagram errors (challenge, session expired) fail the job and mark account `token_expired`
-  **1-hour cooldown** between manual snapshots (enforced server-side)
-  Instagram pagination fixes: `rank_token` format, `big_list` retry, `page_info.end_cursor` fallback
-  `follower_count = Math.max(api_count, edges.length)` prevents bad API values

### Dashboard
-  5 metric cards: New followers, Unfollowed you, Not following you back, You don't follow back, You unfollowed
-  Net follower change callout (green/red)
-  Follower / Following / Friends stats row
-  Streak badge (current + longest)
-  Weekly summary card
-  Growth chart (7d / 30d)
-  Last capture timestamp subtitle
-  Live progress card during capture: keep-open warning, phase/count, pages fetched
-  **"Play while loading"** button opens Tap the Dot mini-game modal
-  1-hour countdown on Daily Snapshot button when rate-limited

### Tap the Dot Mini-Game
-  30-second timed run; dot spawns randomly in safe area
-  Score, time remaining (with shrinking color bar), and high score display
-  Spring animation on dot spawn; tap feedback via `expo-haptics` (graceful no-op if absent)
-  Status pill in modal header: Running (amber) / Complete (green) / Error (red)
-  In-modal toast on snapshot completion: "Snapshot complete  You can close the game anytime."
-  "New high score!" badge at run end
-  High score persisted via AsyncStorage (`stayreel.tapdot.highscore`)
-  Modal does not auto-close when snapshot finishes

### Lists
-  Searchable, paginated (50/page) list for each of the 5 types
-  Reciprocity lists computed server-side from raw snapshot JSON
-  Profile pictures via `unavatar.io/instagram/{username}` with coloured-initial fallback
-  Tapping a user opens `instagram.com/{username}` in device browser

### Settings
-  Disconnect Instagram (soft-deletes `ig_accounts` row, clears local state)
-  Delete all data
-  Remove Ads IAP sheet
-  Consent toggle
-  School row (Account section) — shows current school, opens picker
-  Subscription section — plan display, manage/upgrade CTA
-  Notification toggles — Weekly summary, Refresh complete, New follower (active); Session expiry ("Coming soon", disabled)
-  Sign-out clears push token from Supabase profile

### Push Notifications
-  **Deferred OS prompt** — first-time users see the permission dialog only after their first snapshot (value moment)
-  **Silent re-registration** — returning users' tokens are synced on boot without triggering the dialog
-  **Snapshot-complete push** — sent server-side with duplicate prevention (`completed_notified_at`)
-  **Foreground suppression** — during active capture, `screen=dashboard` pushes are suppressed locally
-  **Notification tap routing** — tapping a push opens the correct screen (dashboard / lists / settings)
-  **Weekly summary push** — `weekly-summary-notify` edge function (cron-triggered)
-  **Sign-out token clearing** — `unregisterPushToken()` on explicit sign-out

### Subscription Paywall (RevenueCat)
-  **Paywall modal** — yearly / monthly plan toggle, purchase + restore flows
-  **Freemium list gating** — snapshots free for all; lists show 10 items then locked rows + upgrade CTA
-  **Server-side truncation** — `list-users` enforces `FREE_PREVIEW_LIMIT = 10` for non-pro users
-  **RevenueCat webhook** — `rc-webhook` edge function syncs `subscription_status` & `subscription_expires_at`
-  **Subscription hydration** — loaded from Supabase + RevenueCat on boot and on warm sign-in
-  **Settings integration** — plan display, manage/upgrade buttons

### School Attribution
-  **Auto-prompt** — SchoolPickerModal appears on first dashboard visit when school is unset
-  **"Don't ask again"** — sets `school_do_not_ask = TRUE`, suppresses future prompts
-  **Settings integration** — school row in Account section, tappable to change

---

## Known Issues / Limitations

- **Instagram fetch reliability**  Instagram may throttle or change private API endpoints at any time. `big_list` mode returns ~19 users/page on many accounts.
- **Incomplete snapshot warning**  no UI indicator when a snapshot is partial (`is_list_complete = false`). Reciprocity numbers silently undercount.
- **Reconnect flow**  when `ig_accounts.status = 'token_expired'`, no prompt is shown on Dashboard yet.
- **`admin-reset-quota`** is still deployed to production  should be removed or key-guarded before wide release.
- No automated tests or CI/CD pipeline.

---

## Still To Do

### High Priority
- [ ] **Incomplete snapshot warning** — surface `is_list_complete` in Dashboard/Lists UI
- [ ] **Reconnect prompt** — when session expired, show "Reconnect Instagram" CTA from Dashboard
- [ ] **Remove `admin-reset-quota`** or add secret-key guard before public release

### Medium Priority
- [ ] **Cron snapshot** — automated hourly/daily capture via pg_cron or GitHub Actions
- [ ] **Second snapshot onboarding nudge** — persistent card after first refresh
- [ ] **List sorting** — AZ or date added
- [ ] **Pull-to-refresh on Lists** — currently only refreshes on tab mount
- [ ] **Session expiry notification** — implement `notify_on_token_expiry` toggle (currently "Coming soon")

### Low Priority / Polish
- [ ] **Real AdMob product IDs** — replace placeholders in `lib/adUnits.ts`
- [ ] **Error boundary** — global React error boundary for unexpected crashes
- [ ] **Accessibility** — `accessibilityLabel` on all interactive elements
- [ ] **App Store / Play Store submission** — privacy policy URL, metadata, screenshots

### Completed (Tasks 4–7)
- [x] **Push notifications** — full MVP with deferred prompt, foreground suppression, weekly summary
- [x] **Subscription paywall** — RevenueCat integration, freemium list gating, webhook
- [x] **School attribution** — ambassador tracking with school picker + "Don't ask again"
- [x] **Notification audit** — dedup prevention, sign-out cleanup, honest copy

---

## Environment Setup Notes

```powershell
# Deploy an Edge Function
npx supabase functions deploy <function-name> --no-verify-jwt

# Apply DB migrations
npx supabase db push

# EAS production build + auto-submit to TestFlight
eas build -p ios --profile production --auto-submit

# Reset dev quota
# POST https://ipepfknhliwuomlsezdt.supabase.co/functions/v1/admin-reset-quota
```

**Supabase project:** `ipepfknhliwuomlsezdt`  
**Bundle ID:** `com.stayreel.ios`  
**Expo SDK:** 54 (`newArchEnabled: false`)
