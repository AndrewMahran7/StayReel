# StayReel — Progress Overview

## What It Is
StayReel is an Instagram follower-tracking app. Users connect their Instagram account via a WebView login flow. The app periodically snapshots their followers and following lists, computes diffs, and surfaces metrics like new followers, unfollowers, and reciprocity (who doesn't follow back).

**Stack:** Expo (React Native) · Supabase (Postgres + Edge Functions + Vault) · Android emulator

---

## Architecture

### Database (Supabase — all 11 migrations applied)
| Table | Purpose |
|---|---|
| `profiles` | One row per auth user (auto-created by trigger on `auth.users`) |
| `ig_accounts` | Connected Instagram accounts (vault_secret_id, status, username) |
| `follower_snapshots` | Each capture: raw `followers_json`, `following_json` arrays + counts |
| `follower_edges` | Normalised per-follower rows (indexed for future set-diff queries) |
| `diffs` | Pre-computed diff between consecutive snapshots (5 list columns + counts) |
| `snapshot_quota` | Per-user daily manual-capture counter (max 2/day, resets midnight UTC) |
| `audit_events` | Immutable log of every significant event |
| `user_settings` | Per-user preferences (consent, ads removed, etc.) |

Row Level Security is enabled on every table. All Edge Functions use the service-role `adminClient` internally.

### Edge Functions
| Function | Method | Purpose |
|---|---|---|
| `connect-instagram` | POST | Receives session cookie from device, stores in Vault, upserts `ig_accounts` + `profiles` |
| `capture-snapshot` | POST | Fetches followers/following from Instagram API, writes snapshot + diff, enforces rate limits |
| `diffs-latest` | GET | Returns latest metrics for dashboard; reciprocity always from raw snapshot JSON |
| `list-users` | GET | Paginated user list for any of the 5 list types; reciprocity always from raw snapshot JSON |
| `status` | GET | Health check |
| `admin-reset-quota` | POST | **Dev only** — resets daily quota and optionally clears snapshot data |

### Mobile App (Expo SDK 54, `newArchEnabled: false`)
```
app/
  (auth)/
    sign-in.tsx          — email/password + magic link login
    connect-instagram.tsx — WebView Instagram login + "Connect" button
  (tabs)/
    dashboard.tsx        — 5 metric cards + net follower callout + Refresh button
    lists.tsx            — searchable, paginated user list with 5 tab types
    settings.tsx         — disconnect IG, delete data, remove-ads IAP, consent

components/
  DashboardCard.tsx      — single metric card (icon, count, chevron)
  UserListItem.tsx       — avatar (unavatar.io profile pic + initial fallback) + @username
  BannerAdView.tsx       — AdMob banner (respects consent + remove-ads state)
  ConsentModal.tsx       — GDPR/ATT consent sheet
  RemoveAdsSheet.tsx     — remove-ads purchase flow
  SearchBar.tsx

hooks/
  useDashboard.ts        — fetches diffs-latest, maps to DiffSummary
  useListData.ts         — infinite query against list-users Edge Function
  useSnapshotCapture.ts  — calls capture-snapshot, surfaces errors
  useInterstitialAd.ts   — frequency-capped interstitial (every N list opens)

store/
  authStore.ts           — user session + igAccountId (Zustand + AsyncStorage)
  adStore.ts             — consent state, ads-removed expiry, list-open counter
```

---

## What Is Working

### Auth & Onboarding
- ✅ Email/password sign-in
- ✅ Magic link sign-in
- ✅ WebView Instagram login — user logs into `instagram.com` in-app, cookies extracted via `@react-native-cookies/cookies`
- ✅ "Connect this account" button appears once the Instagram feed is visible (not auto-detected)
- ✅ Session cookie stored encrypted in Supabase Vault
- ✅ `profiles` row auto-created (backfill migration handles pre-existing users)

### Snapshot Capture
- ✅ Fetches followers + following via Instagram's private Android API (`i.instagram.com/api/v1/friendships/`)
- ✅ `rank_token` added to followers endpoint (required for correct pagination beyond first page)
- ✅ Up to 20 pages × 200 items = 4,000 edges per direction per run
- ✅ Handles challenges, checkpoints, session expiry, rate limits — partial results saved
- ✅ Cadence guard (6-hour minimum) bypassed for first 2 snapshots
- ✅ Daily quota: 2 manual captures/day, resets midnight UTC
- ✅ Diff computed and stored when a previous snapshot exists

### Dashboard
- ✅ 5 metric cards: New followers, Unfollowed you, Not following you back, You don't follow back, You unfollowed
- ✅ Net follower change callout (green/red)
- ✅ Last capture timestamp in subtitle
- ✅ Reciprocity metrics always computed from latest snapshot's raw JSON (immune to incomplete snapshots)
- ✅ Change metrics (new/lost/unfollowed) only shown when `is_complete = true` on the diff
- ✅ `has_diff: false` hint: "Tap Refresh again later to start tracking changes"
- ✅ Empty state when no snapshots exist

### Lists
- ✅ Searchable, paginated (50/page) list for each of the 5 types
- ✅ Reciprocity lists (Ghost / Don't follow) computed server-side from raw snapshot JSON
- ✅ Change lists (New / Lost / Unfollowed) show from stored diff when complete, else "Take a second snapshot to see changes"
- ✅ Profile pictures via `unavatar.io/instagram/{username}` with coloured-initial fallback
- ✅ Tapping a user opens `instagram.com/{username}` in the device browser

### Settings
- ✅ Disconnect Instagram (soft-deletes `ig_accounts` row, clears local state)
- ✅ Delete all data
- ✅ Remove Ads IAP sheet (wired up, needs real product IDs for production)
- ✅ Consent toggle (GDPR/ATT)

---

## Known Issues / Limitations

### Instagram Fetch Reliability
- Instagram rate-limits rapid back-to-back captures — if two Refreshes are taken within seconds both may return incomplete lists (37 followers instead of 820). The 6-hour cadence guard and slower inter-page delay (1.5–3s) mitigate this, but aren't a guarantee.
- `is_list_complete` is stored per snapshot; the diff's `is_complete` field is only true when both parent snapshots were fully fetched. Incomplete diffs currently return zero for all change metrics — users see no explanation of *why* the numbers are 0.
- Instagram may rotate the private API endpoints or require additional headers at any time.

### Reciprocity Accuracy
- Reciprocity numbers are only as accurate as the snapshot data. If a snapshot captured 700 of 820 followers, ~120 followers appear as "not following back" incorrectly.
- No UI indicator of snapshot completeness (users don't know if their data is partial).

### Dev Infrastructure
- `admin-reset-quota` Edge Function is still deployed to production — should be removed or guarded before public release.
- No automated tests (unit or integration).
- No CI/CD pipeline.

---

## Still To Do

### High Priority
- [ ] **Incomplete snapshot warning** — surface `is_list_complete` in the UI. If a snapshot was partial, show a warning banner on Dashboard and Lists instead of silently showing lower-than-real counts.
- [ ] **Reconnect flow** — when `ig_accounts.status = 'token_expired'` or `'suspended'`, prompt the user to reconnect from the Dashboard screen (currently the session silently fails).
- [ ] **Pull-to-refresh on Lists** — currently the list only refreshes when switching tabs or re-mounting; add explicit pull-to-refresh.
- [ ] **Remove `admin-reset-quota`** before any public release (or add a secret key guard).

### Medium Priority
- [ ] **Push notifications** — notify when new followers/unfollowers are detected (requires a cron job deploying `capture-snapshot` with `source: "cron"` and a push token table).
- [ ] **Cron snapshot** — automated daily capture via Supabase scheduled function or external cron (pg_cron / GitHub Actions).
- [ ] **Second snapshot onboarding nudge** — after the first Refresh, show a persistent prompt (e.g., inline card on Dashboard) reminding the user to come back later for their first diff.
- [ ] **Historical chart** — follower count over time using `follower_snapshots.captured_at + follower_count`.
- [ ] **List sorting** — sort by username A–Z or by date added (for change lists).
- [ ] **Deeper user profile** — tap a user in the list → modal with full name, follower count, follow-back status, link to profile (requires Instagram API call per user).

### Low Priority / Polish
- [ ] **Real AdMob product IDs** — replace placeholder IDs in `BannerAdView`, `useInterstitialAd`, `useRewardedAd`, and `RemoveAdsSheet` with production IDs from AdMob console.
- [ ] **iOS build** — currently only Android (dev build) has been tested. iOS requires `@react-native-cookies/cookies` compatibility check and a physical device or macOS.
- [ ] **App icon + splash screen** — currently using Expo defaults.
- [ ] **Error boundary** — global React error boundary to catch unexpected crashes gracefully.
- [ ] **Accessibility** — `accessibilityLabel` on all interactive elements.
- [ ] **App Store / Play Store submission** — privacy policy URL, metadata, screenshots, GDPR consent flow review.

---

## Environment Setup Notes

```powershell
# Must be run each new PowerShell session before building Android
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:PATH = "$env:JAVA_HOME\bin;$env:LOCALAPPDATA\Android\Sdk\platform-tools;" + $env:PATH

# android/local.properties must contain:
# sdk.dir=C\:\\Users\\andre\\AppData\\Local\\Android\\Sdk

# Start dev server
npx expo start

# Build & install on emulator (Medium_Phone_API_36.1)
npx expo run:android

# Deploy an Edge Function
npx supabase functions deploy <function-name> --no-verify-jwt

# Reset dev quota + clear snapshot data
# POST https://ipepfknhliwuomlsezdt.supabase.co/functions/v1/admin-reset-quota
```

**Supabase project:** `ipepfknhliwuomlsezdt`  
**Emulator:** `Medium_Phone_API_36.1:5554`  
**Gradle wrapper:** `gradle-8.13-all.zip`  
**Java:** 21 (Android Studio JBR)
