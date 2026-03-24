# StayReel

**Privacy-first Instagram follower tracker for iOS and Android.**

Track who followed you, who unfollowed you, and who doesn't follow back — without ads in your face and without your data being sold. Built and maintained by one developer.

---

## Features

- **Magic-link sign-in** — no password required, deep-link callback handled automatically
- **Instagram connection** — connect via your `sessionid` cookie, stored AES-256 encrypted in Supabase Vault
- **Resumable snapshots** — chunked job system handles 25k+ follower accounts without server timeouts
- **5 diff categories** — New followers, Unfollowed you, Not following you back, You don't follow back, You unfollowed
- **Growth chart** — 7-day and 30-day follower count history
- **Streak tracking** — current and longest snapshot streak
- **Weekly summary** — new and lost follower counts over the last 7 days
- **Searchable lists** — paginated, searchable, tapping opens the Instagram profile
- **Tap the Dot mini-game** — playable during snapshot loading instead of showing an ad
- **Snapshot error guidance** — plain-English error cards for session expiry, rate limits, and Instagram challenges
- **Troubleshooting screen** — expandable accordion explaining every common error and how to fix it
- **Our Promise screen** — documents what the app will and won't ever do
- **Remove ads** — watch one rewarded ad to go ad-free for 7 days

---

## Tech Stack

| Layer | Choice |
|---|---|
| Mobile framework | Expo SDK 54 / React Native 0.81 |
| Navigation | Expo Router v6 (file-based) |
| Language | TypeScript |
| Data fetching | TanStack React Query v5 |
| Global state | Zustand v5 |
| Backend | Supabase (Auth, Postgres, Edge Functions, Vault) |
| Edge runtime | Deno (Supabase Edge Functions) |
| Ads | react-native-google-mobile-ads |
| Build/deploy | EAS Build + EAS Submit |

---

## Screens

| Screen | Route | Description |
|---|---|---|
| Sign In | `/(auth)/sign-in` | Magic-link entry; App Store review password bypass |
| Connect Instagram | `/(auth)/connect-instagram` | Session cookie entry + step-by-step CookieHelpModal |
| Magic-link callback | `/auth` | Exchanges deep-link code for a Supabase session |
| Dashboard | `/(tabs)/dashboard` | Metrics, chart, streak, snapshot button, mini-game |
| Lists | `/(tabs)/lists` | Searchable, paginated diff lists (5 types) |
| Settings | `/(tabs)/settings` | Account, ads, privacy, danger zone, about |
| Our Promise | `/our-promise` | Product values and what will never happen |
| Troubleshooting | `/troubleshooting` | Expandable error guide with step-by-step fixes |

---

## Architecture

### Snapshot Job System

Manual captures use a **resumable chunked job** to avoid the 150-second Edge Function limit:

1. `snapshot-start` — creates a `snapshot_jobs` row, runs the first ~45 pages (~900 followers)
2. App polls `snapshot-continue` every ~1 second — each call runs the next chunk within a 75-second budget
3. Three phases: `followers` → `following` → `finalize`
4. `finalize` writes `follower_snapshots`, `follower_edges`, diffs, and updates the streak
5. Job cursor is persisted after every chunk — a crash or network blip is safely resumed

**Cooldown:** 1 snapshot per hour per account, enforced server-side.

### Edge Functions

| Function | Purpose |
|---|---|
| `connect-instagram` | Validates session cookie, stores in Vault, upserts `ig_accounts` |
| `snapshot-start` | Creates job, runs first follower chunk |
| `snapshot-continue` | Runs next chunk for an in-progress job |
| `diffs-latest` | Returns dashboard metrics + `next_snapshot_allowed_at` |
| `list-users` | Paginated follower lists (5 types) |
| `snapshot-history` | Historical counts for growth chart |
| `capture-snapshot` | Legacy single-call capture (cron) |
| `status` | Health check |
| `admin-reset-quota` | **Dev only** — resets quota / clears snapshot data |

### Database Tables

| Table | Purpose |
|---|---|
| `profiles` | One row per auth user |
| `ig_accounts` | Connected Instagram accounts; holds Vault secret ID and streak |
| `follower_snapshots` | Per-capture counts; raw JSON kept 30 days then nulled |
| `follower_edges` | Normalised per-follower rows, indexed for set-diff queries |
| `diffs` | Pre-computed diff between consecutive snapshots |
| `snapshot_jobs` | Resumable job state (cursor, phase, accumulated JSON) |
| `snapshot_quota` | Per-user daily quota counter |
| `audit_events` | Immutable event log |
| `user_settings` | Per-user preferences (consent, ads removed TTL, etc.) |

Row-Level Security is enabled on every table. Edge Functions use the service-role `adminClient` internally.

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
    _layout.tsx
    dashboard.tsx
    lists.tsx
    settings.tsx

components/
  BannerAdView.tsx         AdMob banner (hidden when ads removed or no consent)
  ConsentModal.tsx         First-launch GDPR/ATT consent sheet
  CookieHelpModal.tsx      Step-by-step Instagram cookie guide
  DashboardCard.tsx        Stat card with left-accent border and icon
  GrowthChart.tsx          Follower count line chart (7d / 30d toggle)
  RemoveAdsSheet.tsx       Rewarded-ad flow to go ad-free for 7 days
  SearchBar.tsx
  SnapshotErrorCard.tsx    Inline snapshot error with user-friendly guidance
  StatsRow.tsx             Followers / Following / Friends pill row
  StreakBadge.tsx          Current and longest streak display
  TapTheDotGameModal.tsx   Mini-game played during snapshot loading
  UserListItem.tsx         Avatar + @username row
  WeeklySummaryCard.tsx    7-day new/lost follower summary

hooks/
  useDashboard.ts          React Query: fetch diffs-latest metrics
  useListData.ts           React Query: infinite-paginated list
  useSnapshotCapture.ts    Manages start → poll → done job flow; exposes live progress
  useSnapshotHistory.ts    React Query: historical counts for GrowthChart
  useInterstitialAd.ts     Frequency-capped AdMob interstitial
  useRewardedAd.ts         AdMob rewarded for the remove-ads flow
  useTapDotHighScore.ts    AsyncStorage persistence for mini-game high score

lib/
  adUnits.ts               Ad unit ID resolver (test vs production)
  colors.ts                Design token palette
  queryClient.ts           TanStack Query client config
  supabase.ts              Supabase client singleton + deep-link handler

store/
  authStore.ts             Zustand: session + igAccountId (AsyncStorage-persisted)
  adStore.ts               Zustand: consent state, ads-removed expiry, tab open counter

supabase/
  migrations/              001–013, all applied to production
  functions/
    _shared/               auth, cors, errors, instagram, rate_limit, snapshotJob, vault, notify
    connect-instagram/
    snapshot-start/
    snapshot-continue/
    diffs-latest/
    list-users/
    snapshot-history/
    capture-snapshot/
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
npx expo start          # Expo Go (no ads — native build required for ads)
npx expo run:ios        # iOS simulator with native modules
npx expo run:android    # Android emulator with native modules
```

### EAS Build (physical device / App Store submission)

```bash
eas login
eas build --profile production --platform ios --auto-submit
```

---

## Supabase Setup

```bash
npm i -g supabase
supabase link --project-ref <your-project-ref>
supabase db push                              # apply migrations 001–013
supabase functions deploy --no-verify-jwt    # deploy all Edge Functions
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<key>
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `EXPO_PUBLIC_DEV_EMAIL` | App Store review test email |
| `EXPO_PUBLIC_DEV_PASSWORD` | App Store review test password |

`EXPO_PUBLIC_DEV_EMAIL` and `EXPO_PUBLIC_DEV_PASSWORD` are stored as EAS secrets and embedded at build time. Entering the dev email on the sign-in screen reveals a password field — no magic link is sent. Used by App Store reviewers.

---

## Ad Setup

1. Create an AdMob account and an app entry for iOS and Android.
2. Copy the App IDs into `app.json` under the `react-native-google-mobile-ads` plugin.
3. Create three ad units (Banner, Interstitial, Rewarded) and paste the IDs into `lib/adUnits.ts`.

| Event | Ad shown |
|---|---|
| Dashboard / Lists screen | Banner (top, anchored) |
| Every 3rd list-tab switch | Interstitial |
| After a successful snapshot | Interstitial (if ready) |
| Settings → "Remove ads for 7 days" | Rewarded → 7-day ad-free period |

---

## Key Design Decisions

- **No passwords stored** — only the Instagram `sessionid` cookie, AES-256 encrypted via Supabase Vault.
- **Resumable jobs** — chunked pagination survives the 150-second Edge Function limit; cursor is persisted in `snapshot_jobs`.
- **1-hour cooldown** — one manual snapshot per hour per account to protect the user's Instagram account.
- **ig_id matching** — users who rename their Instagram handle are not counted as lost + new followers.
- **30-day TTL on raw lists** — raw follower JSON is nulled by pg_cron after 30 days; diff results are kept indefinitely.
- **Consent first** — `ConsentModal` blocks ad initialisation until the user makes an explicit choice.
- **Mini-game over ads** — the Tap the Dot game is shown during snapshot loading as a user-respecting alternative to interstitial ads.

---

## Known Limitations

- Instagram's private API may throttle or break at any time; `big_list` mode returns ~19 users/page on many accounts.
- No UI indicator yet when a snapshot is partial (`is_list_complete = false`) — reciprocity numbers may undercount.
- No automated tests or CI/CD pipeline.
- `admin-reset-quota` is still deployed to production — should be removed or key-guarded before wide release.

---

## License

MIT
