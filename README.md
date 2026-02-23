# StayReel  Instagram Follower Tracker

A privacy-first React Native app (Expo) that tracks your Instagram follower changes over time.
Built with **Expo Router v4**, **Supabase**, **React Query**, and **Google Mobile Ads**.

---

## Screens

| Screen | Route | Description |
|---|---|---|
| Sign In | `/(auth)/sign-in` | Magic-link + App Store review password bypass |
| Connect Instagram | `/(auth)/connect-instagram` | Enter username + paste `sessionid` cookie |
| Dashboard | `/(tabs)/dashboard` | 5 stat cards, growth chart, streak, manual refresh with progress + mini-game |
| Lists | `/(tabs)/lists` | Searchable, paginated follower lists |
| Settings | `/(tabs)/settings` | Disconnect, delete data, ad consent |

---

## Project Structure

```
stayreel/
 app/
    _layout.tsx              Root layout (providers + auth guard)
    auth.tsx                 Deep-link handler for magic-link callbacks
    (auth)/
       _layout.tsx
       sign-in.tsx
       connect-instagram.tsx
    (tabs)/
        _layout.tsx          Bottom tab navigator
        dashboard.tsx
        lists.tsx
        settings.tsx
 components/
    BannerAdView.tsx         AdMob banner (hidden when ads removed)
    ConsentModal.tsx         First-launch GDPR consent
    CookieHelpModal.tsx      Step-by-step IG cookie guide
    DashboardCard.tsx        Stat card with left-accent border
    GrowthChart.tsx          Follower count line chart (7d / 30d)
    RemoveAdsSheet.tsx       "Watch ad to remove ads for 7 days"
    SearchBar.tsx
    StatsRow.tsx             Followers / Following / Friends counts
    StreakBadge.tsx          Current & longest streak display
    TapTheDotGameModal.tsx   Mini-game played during snapshot loading
    UserListItem.tsx
    WeeklySummaryCard.tsx    7-day new/lost follower summary
 hooks/
    useDashboard.ts          React Query: fetch diffs-latest summary
    useInterstitialAd.ts     AdMob interstitial (frequency-capped)
    useListData.ts           React Query: infinite paginated list
    useRewardedAd.ts         AdMob rewarded (ad-removal)
    useSnapshotCapture.ts    Resumable job system: start  poll  done
    useSnapshotHistory.ts    React Query: follower count history for chart
    useTapDotHighScore.ts    AsyncStorage persistence for mini-game score
 lib/
    adUnits.ts               Ad unit ID resolver (test vs prod)
    colors.ts                Design token palette
    queryClient.ts           TanStack Query client config
    supabase.ts              Supabase client + deep-link handler
 store/
    adStore.ts               Zustand: ad consent + removal TTL
    authStore.ts             Zustand: session + ig_account_id
 supabase/
     migrations/              001013 applied to production
     functions/
         _shared/             auth, cors, errors, instagram, rate_limit, snapshotJob, vault, 
         capture-snapshot/    Legacy single-call capture (cron)
         connect-instagram/
         diffs-latest/        Dashboard metrics + next_snapshot_allowed_at
         list-users/          Paginated follower lists
         snapshot-continue/   Poll next chunk of a running job
         snapshot-history/    Historical counts for growth chart
         snapshot-start/      Create job + run first chunk
         status/
         admin-reset-quota/   Dev only
```

---

## Prerequisites

- Node.js 20+
- [Expo CLI](https://docs.expo.dev/get-started/installation/): `npm i -g expo-cli`
- [EAS CLI](https://docs.expo.dev/eas/): `npm i -g eas-cli`
- Supabase project with the migrations in `supabase/migrations/` applied
- Google AdMob account (test IDs work out of the box)

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env and set EXPO_PUBLIC_SUPABASE_URL + EXPO_PUBLIC_SUPABASE_ANON_KEY

# 3. Start the dev server (Expo Go)
npx expo start
```

> **Note:** `react-native-google-mobile-ads` requires a **native build** to show real ads.
> In Expo Go the ad components render nothing (this is normal).
> Use `npx expo run:ios` / `npx expo run:android` or EAS Build for ad testing.

---

## Native Build (Ad Testing)

```bash
# iOS simulator
npx expo run:ios

# Android emulator
npx expo run:android
```

### EAS Build (physical device / submission)

```bash
npm i -g eas-cli
eas login
eas build --profile production --platform ios --auto-submit
```

---

## Snapshot Job System

Manual snapshots use a **resumable chunked job** architecture to handle accounts with 25k+ followers without hitting the 150 s Edge Function timeout.

1. App calls `POST /snapshot-start`  creates a `snapshot_jobs` row and runs the first ~45 pages of followers.
2. App polls `POST /snapshot-continue` every 1 s, each call running the next chunk within a 75 s budget.
3. Once all followers **and** following are fetched, the `finalize` phase writes `follower_snapshots`, `follower_edges`, diffs, and updates the streak.
4. The `snapshot_jobs` row persists cursor state between calls, so a crash or network blip is safely resumed.

Cooldown: **1 hour** per account (enforced via `ig_accounts.last_snapshot_at`).

---

## iOS AdMob Setup

1. Create an AdMob account at [admob.google.com](https://admob.google.com).
2. Create an iOS App in AdMob  copy the **App ID** (format: `ca-app-pub-XXXX~YYYY`).
3. Update `app.json`:
   ```json
   "plugins": [
     ["react-native-google-mobile-ads", {
       "iosAppId": "ca-app-pub-6049273265076763~7693569711",
       "androidAppId": "ca-app-pub-XXXX~YYYY"
     }]
   ]
   ```
4. Create three ad units (Banner, Interstitial, Rewarded) and paste the IDs into `lib/adUnits.ts`.
5. Add your Apple App ID to AdMob for SKAdNetwork attribution.

### Test Ad Units (always safe in development)

| Format | iOS | Android |
|---|---|---|
| Banner | `ca-app-pub-3940256099942544/2934735716` | `ca-app-pub-3940256099942544/6300978111` |
| Interstitial | `ca-app-pub-3940256099942544/4411468910` | `ca-app-pub-3940256099942544/1033173712` |
| Rewarded | `ca-app-pub-3940256099942544/1712485313` | `ca-app-pub-3940256099942544/5224354917` |

---

## Ad Logic

| Event | Ad Shown |
|---|---|
| Dashboard / Lists screen | Banner (top, anchored adaptive) |
| Every 3rd list-type tab switch | Interstitial |
| After successful snapshot capture | Interstitial (if ready) |
| Settings  "Remove ads for 7 days" | Rewarded  7-day ad-free period |

Frequency caps are enforced in `store/adStore.ts` (`INTERSTITIAL_EVERY_N_OPENS = 3`).

---

## Supabase Setup

```bash
npm i -g supabase
supabase link --project-ref your-project-ref

# Apply all migrations (001013)
supabase db push

# Deploy all Edge Functions
supabase functions deploy --no-verify-jwt
```

Required secret:
```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `EXPO_PUBLIC_DEV_EMAIL` | App Store review test account email |
| `EXPO_PUBLIC_DEV_PASSWORD` | App Store review test account password |

`EXPO_PUBLIC_DEV_EMAIL` and `EXPO_PUBLIC_DEV_PASSWORD` are stored as EAS secrets and embedded at build time.
On the sign-in screen, entering the dev email reveals a password field and signs in directly (no magic link required)  used by App Store reviewers.

---

## App Store Review Login

**Email:** `dev@stayreel.test`  
**Password:** `devpass123`

Enter the email on the sign-in screen  a password field appears automatically. No email is sent.

---

## Key Design Decisions

- **No passwords stored**  only the Instagram `sessionid` cookie, AES-256 encrypted via Supabase Vault.
- **Resumable snapshot jobs**  chunked pagination survives the 150 s Edge Function timeout; cursor persisted in `snapshot_jobs` table.
- **1-hour cooldown**  one manual snapshot per hour per account.
- **ig_id matching**  users who rename their Instagram handle are not counted as lost+new.
- **30-day TTL on raw follower lists**  raw JSON nulled by pg_cron; diff results kept forever.
- **Consent first**  `ConsentModal` blocks ad initialisation until the user makes a choice.

---

## License

MIT
