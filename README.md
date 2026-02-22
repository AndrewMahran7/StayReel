# StayReel — Instagram Follower Tracker

A privacy-first React Native app (Expo) that tracks your Instagram follower changes over time.
Built with **Expo Router v4**, **Supabase**, **React Query**, and **Google Mobile Ads**.

---

## Screens

| Screen | Route | Description |
|---|---|---|
| Sign In | `/(auth)/sign-in` | Passwordless magic-link via Supabase |
| Connect Instagram | `/(auth)/connect-instagram` | Enter username + paste `sessionid` cookie |
| Dashboard | `/(tabs)/dashboard` | 5 stat cards + manual refresh |
| Lists | `/(tabs)/lists` | Searchable, paginated follower lists |
| Settings | `/(tabs)/settings` | Disconnect, delete data, ad consent |

---

## Project Structure

```
stayreel/
├── app/
│   ├── _layout.tsx              Root layout (providers + auth guard)
│   ├── (auth)/
│   │   ├── _layout.tsx
│   │   ├── sign-in.tsx
│   │   └── connect-instagram.tsx
│   └── (tabs)/
│       ├── _layout.tsx          Bottom tab navigator
│       ├── dashboard.tsx
│       ├── lists.tsx
│       └── settings.tsx
├── components/
│   ├── BannerAdView.tsx         AdMob banner (hidden when ads removed)
│   ├── ConsentModal.tsx         First-launch GDPR consent
│   ├── CookieHelpModal.tsx      Step-by-step IG cookie guide
│   ├── DashboardCard.tsx        Stat card
│   ├── RemoveAdsSheet.tsx       "Watch ad to remove ads for 7 days"
│   ├── SearchBar.tsx
│   └── UserListItem.tsx
├── hooks/
│   ├── useDashboard.ts          React Query: fetch latest diff summary
│   ├── useInterstitialAd.ts     AdMob interstitial
│   ├── useListData.ts           React Query: infinite paginated list
│   ├── useRewardedAd.ts         AdMob rewarded (ad-removal)
│   └── useSnapshotCapture.ts    Mutation: trigger capture-snapshot
├── lib/
│   ├── adUnits.ts               Ad unit ID resolver (test vs prod)
│   ├── colors.ts                Design token palette
│   ├── queryClient.ts           TanStack Query client config
│   └── supabase.ts              Supabase client + deep-link handler
├── store/
│   ├── adStore.ts               Zustand: ad consent + removal TTL
│   └── authStore.ts             Zustand: session + ig_account_id
└── supabase/                    Edge Functions + migrations (see backend README)
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
# Install EAS CLI
npm i -g eas-cli
eas login

# Configure project (first time)
eas build:configure

# Development build
eas build --profile development --platform ios

# Production build
eas build --profile production --platform all
```

---

## iOS AdMob Setup

1. Create an AdMob account at [admob.google.com](https://admob.google.com).
2. Create an iOS App in AdMob → copy the **App ID** (format: `ca-app-pub-XXXX~YYYY`).
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

### App Tracking Transparency (iOS 14+)

The `NSUserTrackingUsageDescription` key is already set in `app.json`.
The `ConsentModal` covers basic GDPR consent for personalised ads.
For full App Store compliance, integrate the
[Google UMP SDK](https://developers.google.com/admob/ump/ios/quick-start)
before release.

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
| Settings → "Remove ads for 7 days" | Rewarded → 7-day ad-free period |

Frequency caps are enforced in `store/adStore.ts` (`INTERSTITIAL_EVERY_N_OPENS = 3`).
All ads respect the user's consent choice and are hidden during the ad-free period.

---

## Supabase Setup

```bash
# Install Supabase CLI
npm i -g supabase

# Link your project
supabase link --project-ref your-project-ref

# Apply all migrations (001–009)
supabase db push

# Deploy Edge Functions
supabase functions deploy connect-instagram
supabase functions deploy capture-snapshot
supabase functions deploy diffs-latest
supabase functions deploy status
```

Set the following Edge Function secrets:

```bash
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

---

## Environment Variables

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |

---

## Key Design Decisions

- **No passwords stored** — only the Instagram `sessionid` cookie, AES-256 encrypted via Supabase Vault.
- **Server-side rate limiting** — max 2 manual refreshes/day, minimum 6-hour gap between snapshots.
- **ig_id matching** — users who rename their Instagram handle are not counted as lost+new.
- **30-day TTL on raw follower lists** — raw JSON is nulled by a pg_cron job; diff results are kept forever.
- **Consent first** — the `ConsentModal` blocks ad initialisation until the user makes a choice.

---

## License

MIT
