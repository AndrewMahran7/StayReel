# StayReel — Instagram Follower Tracker MVP Build Plan

> Stack: Expo (React Native) · Supabase (Auth + Postgres + Edge Functions) · AdMob (free tier) · GitHub Actions CI

---

## 1. Repo Structure

```
stayreel/
├── apps/
│   └── mobile/                        # Expo app
│       ├── app/                       # Expo Router file-based navigation
│       │   ├── (auth)/
│       │   │   ├── login.tsx
│       │   │   └── register.tsx
│       │   ├── (tabs)/
│       │   │   ├── _layout.tsx
│       │   │   ├── dashboard.tsx      # follower count + trend chart
│       │   │   ├── diff.tsx           # gained / lost diff list
│       │   │   ├── history.tsx        # snapshot timeline
│       │   │   └── settings.tsx
│       │   ├── _layout.tsx            # root layout (auth guard)
│       │   └── index.tsx              # redirect splash
│       ├── components/
│       │   ├── AdBanner.tsx
│       │   ├── FollowerCard.tsx
│       │   ├── DiffRow.tsx
│       │   ├── TrendChart.tsx
│       │   └── WarningBanner.tsx
│       ├── hooks/
│       │   ├── useSnapshots.ts
│       │   ├── useDiff.ts
│       │   └── useAuth.ts
│       ├── lib/
│       │   ├── supabase.ts            # Supabase client singleton
│       │   ├── instagram.ts           # scrape/graph helper
│       │   └── notifications.ts
│       ├── store/
│       │   └── authStore.ts           # Zustand
│       ├── constants/
│       │   └── theme.ts
│       ├── app.json
│       ├── eas.json
│       └── package.json
│
├── supabase/
│   ├── migrations/
│   │   ├── 001_init.sql
│   │   ├── 002_snapshots.sql
│   │   └── 003_rls.sql
│   ├── functions/
│   │   ├── take-snapshot/
│   │   │   └── index.ts              # scheduled Edge Function
│   │   ├── refresh-token/
│   │   │   └── index.ts              # Instagram token refresh
│   │   └── send-notification/
│   │       └── index.ts
│   └── seed.sql
│
├── .github/
│   └── workflows/
│       ├── ci.yml                     # lint + type-check + test
│       └── eas-build.yml              # EAS build on tag
│
├── docs/
│   └── privacy-policy.md              # required for app store + IG API
├── .env.example
└── README.md
```

---

## 2. Database Schema (SQL)

```sql
-- ─────────────────────────────────────────────
-- 001_init.sql
-- ─────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users are handled by Supabase Auth (auth.users).
-- We extend with a profile table.

CREATE TABLE public.profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name  TEXT,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Linked Instagram accounts (one user can track multiple handles)
CREATE TABLE public.ig_accounts (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  ig_user_id        TEXT NOT NULL,                -- Instagram numeric user ID
  username          TEXT NOT NULL,
  -- Store ONLY the long-lived access token, never a password
  access_token      TEXT,                         -- encrypted at rest via Supabase Vault
  token_expires_at  TIMESTAMPTZ,
  is_connected      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, ig_user_id)
);

-- ─────────────────────────────────────────────
-- 002_snapshots.sql
-- ─────────────────────────────────────────────

-- Point-in-time follower count snapshots
CREATE TABLE public.follower_snapshots (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ig_account_id UUID NOT NULL REFERENCES public.ig_accounts(id) ON DELETE CASCADE,
  taken_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  follower_count INTEGER NOT NULL,
  following_count INTEGER NOT NULL,
  post_count      INTEGER NOT NULL DEFAULT 0,
  -- raw follower list stored as JSONB array of {ig_id, username}
  -- only kept for 30 days to limit storage; older snapshots keep only counts
  follower_list JSONB,
  list_expires_at TIMESTAMPTZ GENERATED ALWAYS AS (taken_at + INTERVAL '30 days') STORED
);

CREATE INDEX idx_snapshots_account_time ON public.follower_snapshots(ig_account_id, taken_at DESC);

-- Computed diffs between consecutive snapshots
CREATE TABLE public.follower_diffs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ig_account_id   UUID NOT NULL REFERENCES public.ig_accounts(id) ON DELETE CASCADE,
  from_snapshot   UUID NOT NULL REFERENCES public.follower_snapshots(id),
  to_snapshot     UUID NOT NULL REFERENCES public.follower_snapshots(id),
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  net_change      INTEGER NOT NULL,              -- positive = gained
  gained_users    JSONB,                         -- [{ig_id, username}]
  lost_users      JSONB,
  UNIQUE (from_snapshot, to_snapshot)
);

CREATE INDEX idx_diffs_account_time ON public.follower_diffs(ig_account_id, computed_at DESC);

-- Rate-limit tracking per user per day
CREATE TABLE public.snapshot_quota (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  date          DATE NOT NULL DEFAULT CURRENT_DATE,
  manual_count  INTEGER NOT NULL DEFAULT 0,       -- user-triggered refreshes
  UNIQUE (user_id, date)
);

-- App-level settings per user
CREATE TABLE public.user_settings (
  user_id             UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  notify_on_unfollow  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_on_new       BOOLEAN NOT NULL DEFAULT FALSE,
  snapshot_frequency  TEXT NOT NULL DEFAULT 'daily'   -- 'hourly' | 'daily'
                      CHECK (snapshot_frequency IN ('hourly','daily')),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- 003_rls.sql  — Row Level Security
-- ─────────────────────────────────────────────

ALTER TABLE public.profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ig_accounts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follower_diffs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.snapshot_quota      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings       ENABLE ROW LEVEL SECURITY;

-- Profiles: only own row
CREATE POLICY "own profile" ON public.profiles
  FOR ALL USING (auth.uid() = id);

-- IG accounts: only own accounts
CREATE POLICY "own ig_accounts" ON public.ig_accounts
  FOR ALL USING (auth.uid() = user_id);

-- Snapshots: only via owned ig_accounts
CREATE POLICY "own snapshots" ON public.follower_snapshots
  FOR ALL USING (
    ig_account_id IN (
      SELECT id FROM public.ig_accounts WHERE user_id = auth.uid()
    )
  );

-- Diffs: same as snapshots
CREATE POLICY "own diffs" ON public.follower_diffs
  FOR ALL USING (
    ig_account_id IN (
      SELECT id FROM public.ig_accounts WHERE user_id = auth.uid()
    )
  );

-- Quota: own row only
CREATE POLICY "own quota" ON public.snapshot_quota
  FOR ALL USING (auth.uid() = user_id);

-- Settings: own row only
CREATE POLICY "own settings" ON public.user_settings
  FOR ALL USING (auth.uid() = user_id);
```

---

## 3. API Surface

All write operations go through **Supabase Edge Functions** (Deno). The mobile client only ever calls:
1. Supabase Auth endpoints (built-in)
2. Edge Functions via `supabase.functions.invoke()`
3. Direct Supabase DB reads (RLS-protected)

### 3.1 Edge Functions

| Function | Trigger | Description |
|---|---|---|
| `take-snapshot` | **Cron** every 1 h + **manual** HTTP POST | Fetches follower list via IG Basic Display API, writes `follower_snapshots`, computes diff, writes `follower_diffs`, sends push if threshold met |
| `refresh-token` | **Cron** every 50 days | Refreshes long-lived IG tokens before 60-day expiry |
| `send-notification` | Called by `take-snapshot` | Sends Expo push notification via Expo Push API |
| `delete-account` | HTTP DELETE from settings screen | Cascades delete of all user data + revokes IG token |

### 3.2 `take-snapshot` Logic (pseudocode)

```typescript
// supabase/functions/take-snapshot/index.ts
export default async (req: Request) => {
  const { ig_account_id, user_id } = await req.json();

  // 1. Rate-limit check — max 3 manual refreshes per day per user
  const quota = await checkAndIncrementQuota(user_id);
  if (quota.manual_count > 3) return new Response("Rate limit exceeded", { status: 429 });

  // 2. Fetch from Instagram Basic Display API
  const igData = await fetchInstagramFollowers(ig_account_id);

  // 3. Write snapshot
  const snapshot = await insertSnapshot(ig_account_id, igData);

  // 4. Compute diff vs. prior snapshot
  const prior = await getPriorSnapshot(ig_account_id);
  if (prior) {
    const diff = computeDiff(prior.follower_list, snapshot.follower_list);
    await insertDiff(ig_account_id, prior.id, snapshot.id, diff);

    // 5. Send push if notable change
    if (diff.lost_users.length > 0 || diff.gained_users.length >= 10) {
      await sendNotification(user_id, diff);
    }
  }

  return new Response(JSON.stringify({ snapshot_id: snapshot.id }), { status: 200 });
};
```

### 3.3 Client-side Data Access (direct Supabase queries)

```typescript
// Latest follower count
supabase
  .from('follower_snapshots')
  .select('follower_count, taken_at')
  .eq('ig_account_id', id)
  .order('taken_at', { ascending: false })
  .limit(30)

// Latest diff
supabase
  .from('follower_diffs')
  .select('net_change, gained_users, lost_users, computed_at')
  .eq('ig_account_id', id)
  .order('computed_at', { ascending: false })
  .limit(1)
  .single()
```

---

## 4. Client Screens & Navigation

```
Root Layout (auth guard)
├── (auth) group — shown when logged out
│   ├── /login          → Email magic link OR Google OAuth
│   └── /register       → Same form, auto-detects new vs. returning
│
└── (tabs) group — shown when logged in
    ├── Dashboard  [Home icon]
    │     • Header: tracked username + avatar
    │     • Big follower count + delta badge (+12 / -3)
    │     • TrendChart (sparkline, 30-day)
    │     • "Refresh Now" button (consumes quota)
    │     • AdBanner at bottom (AdMob banner)
    │
    ├── Diff  [People icon]
    │     • Two tabs: "Unfollowed You" | "New Followers"
    │     • FlatList of DiffRow (avatar · username · time ago)
    │     • Interstitial ad shown every 3rd manual diff refresh
    │
    ├── History  [Chart icon]
    │     • Full snapshot timeline (date · count · net change)
    │     • Tap row → detailed diff modal for that period
    │
    └── Settings  [Gear icon]
          • Connected IG account (connect / disconnect)
          • Notification toggles
          • Snapshot frequency selector
          • "Delete my account & data" (calls delete-account function)
          • Privacy Policy link
          • App version
```

### Navigation & State

- **Expo Router** v3 (file-based, built-in deep linking)
- **Zustand** for auth state + active ig_account_id
- **React Query** (`@tanstack/react-query`) for all server state with 5-min stale time
- Deep link: `stayreel://diff?account_id=xxx` triggered from push notification

---

## 5. Risk Controls

### 5.1 No Password Storage
- Auth is **Supabase Auth only** — email magic link + optional Google OAuth
- Instagram credentials are **never collected**. Only the IG Basic Display API OAuth flow is used, yielding a long-lived token stored in Supabase Vault (AES-256 encrypted column)
- Token is only ever read server-side within Edge Functions; never sent to the client

### 5.2 Rate Limiting
| Layer | Limit | Enforcement |
|---|---|---|
| Manual snapshot refreshes | 3 per user per day | `snapshot_quota` table check in Edge Function, returns HTTP 429 |
| Cron snapshots | 1 per hour per account (daily plan), 1 per hour (hourly plan) | Scheduled function handles scheduling |
| IG Basic Display API | 200 calls/hour per token | Monitored in Edge Function; if 429 received, exponential backoff + user notification |
| Supabase Edge Function | Supabase built-in: 500k invocations/month free | Alerts if >80% consumed |

### 5.3 User Warnings & Disclosures
- **Onboarding screen** (shown once): "This app uses Instagram's official API. It cannot track private accounts you don't own. Connecting grants read-only access to your follower list. You can revoke access at any time."
- **WarningBanner component**: shown on Dashboard when token is expiring < 7 days
- **TOS compliance notice**: in-app disclosure that this app is not affiliated with Meta/Instagram
- **Data retention notice**: raw follower lists are deleted after 30 days (only counts kept)
- **Unfollow notifications**: include disclaimer "This person may have deactivated their account"
- **Delete account**: soft-confirm dialog → hard-confirm with email OTP before destructive action

### 5.4 Additional Hardening
- All Supabase RLS policies tested in CI using `supabase test db`
- `access_token` column is `security definer` read-restricted; only Edge Functions access it via service-role key
- CORS restricted on Edge Functions to the app's bundle ID origin
- Expo SecureStore used for Supabase session (not AsyncStorage)
- EAS environment secrets — no keys in source code or `.env` committed to git

---

## 6. Day-by-Day Execution Schedule (14 Days)

### Day 1 — Foundation
- [ ] Create GitHub repo, add `.gitignore`, `README.md`, `docs/privacy-policy.md`
- [ ] `npx create-expo-app mobile --template tabs` inside `apps/`
- [ ] Install core deps: `@supabase/supabase-js`, `expo-router`, `zustand`, `@tanstack/react-query`, `expo-secure-store`, `react-native-google-mobile-ads`
- [ ] Create Supabase project, note `SUPABASE_URL` + `SUPABASE_ANON_KEY`
- [ ] Run `001_init.sql` migration via Supabase Dashboard
- [ ] Bootstrap `lib/supabase.ts` singleton with SecureStore session adapter

### Day 2 — Auth Flow
- [ ] Run `002_snapshots.sql` + `003_rls.sql` migrations
- [ ] Implement `(auth)/login.tsx` + `(auth)/register.tsx` with Supabase magic-link
- [ ] Add Google OAuth provider in Supabase + Expo AuthSession redirect
- [ ] Wire `authStore.ts` (Zustand) — session listener on `onAuthStateChange`
- [ ] Root `_layout.tsx` auth guard — redirect unauthenticated users to `/login`
- [ ] Test: sign up, sign in, sign out, session persistence across app restart

### Day 3 — Instagram OAuth Integration
- [ ] Register app on Meta Developer Portal → Basic Display API product
- [ ] Implement OAuth flow in `lib/instagram.ts` using `expo-web-browser` + `expo-auth-session`
- [ ] On success: exchange code for short-lived token → server-side exchange for long-lived token via `refresh-token` Edge Function
- [ ] Save `ig_accounts` row with encrypted token via Edge Function (service role key)
- [ ] Settings screen: "Connect Instagram" button + connected state display
- [ ] Test: connect, verify token stored (not visible to client), disconnect revokes token

### Day 4 — Snapshot Edge Function
- [ ] Write `take-snapshot` Edge Function (TypeScript/Deno)
- [ ] Instagram Basic Display API: `GET /me/followers` with pagination
- [ ] Insert `follower_snapshots` row; compute diff vs. prior; insert `follower_diffs`
- [ ] `snapshot_quota` rate-limit enforcement (429 on breach)
- [ ] Deploy to Supabase: `supabase functions deploy take-snapshot`
- [ ] Manual test via `curl` with a real IG token

### Day 5 — Dashboard Screen
- [ ] Build `(tabs)/dashboard.tsx`
- [ ] `useSnapshots` hook — React Query, fetches last 30 snapshots
- [ ] `TrendChart` component (Victory Native or Gifted Charts — pick Victory Native)
- [ ] Follower count display + net delta badge
- [ ] "Refresh Now" button → calls `take-snapshot` Edge Function → invalidates React Query cache
- [ ] `AdBanner` component (AdMob banner, test ID in dev, real ID via EAS secret in prod)

### Day 6 — Diff Screen
- [ ] Build `(tabs)/diff.tsx` with "Unfollowed" / "New Followers" tabs
- [ ] `useDiff` hook — fetches latest diff for active ig_account_id
- [ ] `DiffRow` component: profile avatar (initials fallback), username, time ago
- [ ] Pull-to-refresh triggers new snapshot + diff recompute
- [ ] AdMob interstitial: every 3rd pull-to-refresh (tracked in local state)
- [ ] Empty state: "No changes since last check"

### Day 7 — History Screen + Notifications
- [ ] Build `(tabs)/history.tsx` — FlatList of all snapshots with net change column
- [ ] Tap → modal overlay showing gained/lost for that diff period
- [ ] `send-notification` Edge Function using Expo Push API
- [ ] Integrate push token registration in `lib/notifications.ts` on app launch
- [ ] Store `expo_push_token` in `profiles` table
- [ ] End-to-end push test: trigger snapshot → receive notification on device

### Day 8 — Settings Screen + Risk Controls UI
- [ ] Full `(tabs)/settings.tsx`
- [ ] Notification toggles wired to `user_settings` table
- [ ] Snapshot frequency selector (daily / hourly)
- [ ] Token expiry `WarningBanner` (checks `token_expires_at < now() + 7 days`)
- [ ] "Delete account" flow: soft confirm → OTP confirm → call `delete-account` Edge Function → sign out
- [ ] Onboarding disclosure modal (shown once via AsyncStorage flag)

### Day 9 — Cron Jobs + Token Refresh
- [ ] Set up Supabase Cron (pg_cron): `take-snapshot` every hour for `hourly` accounts, once daily for `daily` accounts
- [ ] `refresh-token` Edge Function: refreshes tokens with < 10 days remaining
- [ ] Cron: `refresh-token` runs daily
- [ ] Verify: `follower_list` column set to NULL on rows older than 30 days (pg_cron cleanup job)
- [ ] Test full automated cycle without manual intervention

### Day 10 — Polish & Error Handling
- [ ] Global error boundary in root `_layout.tsx`
- [ ] Loading skeletons on Dashboard + Diff (replace spinners)
- [ ] Network offline banner (NetInfo)
- [ ] Graceful IG API error states: expired token, rate-limited, private account
- [ ] Haptics on "Refresh Now" (expo-haptics)
- [ ] Dark mode support via `theme.ts` + `useColorScheme`

### Day 11 — Testing
- [ ] Jest + `@testing-library/react-native`: unit tests for `useDiff`, `computeDiff`, `useSnapshots`
- [ ] Supabase local emulator: `supabase start` + RLS policy tests (`supabase test db`)
- [ ] E2E: Maestro flow — launch → login → connect IG → view dashboard → pull to refresh → check diff
- [ ] Fix all CI failures in `ci.yml` (lint, type-check, tests must pass on push)

### Day 12 — AdMob Integration & Monetisation Audit
- [ ] Register app in AdMob, create Banner + Interstitial ad units
- [ ] Set real ad unit IDs in EAS secrets; test ad IDs in development
- [ ] Verify ad load failure doesn't crash app (graceful fallback)
- [ ] Confirm GDPR/CCPA consent flow via `react-native-google-mobile-ads` UMP SDK
- [ ] Review ad frequency caps — max 1 interstitial per 3 user-triggered refreshes

### Day 13 — App Store Prep
- [ ] `eas.json` configured: `development`, `preview`, `production` profiles
- [ ] App icons + splash screen (1024×1024 icon, splash via `expo-splash-screen`)
- [ ] `app.json`: bundle ID `com.stayreel.app`, version `1.0.0`, permissions (push notifications only)
- [ ] `docs/privacy-policy.md` → publish to GitHub Pages (required by Apple + Meta)
- [ ] EAS Build: `eas build --platform all --profile production`
- [ ] Fill out App Store Connect + Google Play Console metadata

### Day 14 — Submit & Monitor
- [ ] Submit iOS build via `eas submit --platform ios`
- [ ] Submit Android AAB via `eas submit --platform android`
- [ ] Set up Sentry (free tier) for crash reporting: `expo install @sentry/react-native`
- [ ] Supabase dashboard: confirm RLS is enabled on all tables, no public access
- [ ] Create `v1.0.0` git tag → triggers `eas-build.yml` GitHub Actions workflow
- [ ] Monitor App Store review status; respond to reviewer questions within 24 h

---

## 7. Key Dependencies

```json
{
  "dependencies": {
    "expo": "~52.0.0",
    "expo-router": "~4.0.0",
    "expo-auth-session": "~6.0.0",
    "expo-web-browser": "~14.0.0",
    "expo-secure-store": "~14.0.0",
    "expo-notifications": "~0.29.0",
    "expo-haptics": "~14.0.0",
    "@supabase/supabase-js": "^2.45.0",
    "zustand": "^5.0.0",
    "@tanstack/react-query": "^5.0.0",
    "victory-native": "^41.0.0",
    "react-native-google-mobile-ads": "^14.0.0",
    "@sentry/react-native": "~6.0.0",
    "@react-native-community/netinfo": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@testing-library/react-native": "^12.0.0",
    "jest": "^29.0.0",
    "jest-expo": "~52.0.0"
  }
}
```

---

## 8. Critical Path & Risks

| Risk | Probability | Mitigation |
|---|---|---|
| Meta Basic Display API deprecation (deprecated Nov 2024) | **HIGH** | Fall back to unofficial apify.com Instagram scraper actor as backup data source behind the same `take-snapshot` interface; swap without client changes |
| Apple reject for scraping / TOS violation | Medium | Use only official API or disclosed scraping; privacy policy must be live before submission |
| IG rate limits (200 req/hr per token) | Medium | Batch pagination, cache aggressively, avoid redundant calls |
| AdMob approval delay (1–3 days) | Low | Use test ad IDs for launch; real ads activate after approval |
| Supabase free tier storage (500 MB) | Low | 30-day follower_list TTL + pg_cron cleanup keeps storage bounded |

> **Note on Instagram API**: The Basic Display API was deprecated November 2024. The recommended replacement is the **Instagram Graph API** (for business/creator accounts) or the new **Instagram API with Instagram Login**. Architecture above uses the same `take-snapshot` abstraction — swap the data-fetching adapter in `lib/instagram.ts` without changing any other layer.

---

*Total estimated dev time: ~90–110 focused hours over 14 days (solo developer).*
*Pair this plan with daily 15-min standup notes in `docs/devlog.md` to stay on track.*
