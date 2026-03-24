# StayReel — Integration Audit (Tasks 1–7)

> Generated after a full-codebase review of all files touched by the seven feature tasks.

---

## 1. What Changed (Summary)

### Task 1 — Auth Bug Fixes
- **Session persistence** — conditional token refresh avoids burning refresh tokens on every cold start
- **Magic-link deep-link** — `app/auth.tsx` catches `stayreel://auth?code=…` with a spinner + 15 s timeout fallback
- **PKCE race guard** — `getInitialURL` processed inside `bootstrap()` before `getSession()` so the exchange token is available immediately

### Task 2 — Snapshot Large-Account Stability
- **Resumable job system** — `snapshot_jobs` table + `snapshot-start` / `snapshot-continue` edge functions
- **Chunked Instagram pagination** — `fetchEdgeListChunked` with time-budget and cursor persistence
- **Live progress card** — shows phase, count, and pages fetched during capture
- **Tap the Dot mini-game** — shown during loading to improve perceived wait time

### Task 3 — Login Email Template
- **`supabase/templates/magic-link.html`** — branded HTML email with dark theme, PKCE-compatible `{{ .ConfirmationURL }}`

### Task 4 — Push Notification MVP
- **`lib/notifications.ts`** — registration, foreground handler (with snapshot suppression), token management
- **`hooks/useNotifications.ts`** — silent re-registration on boot, notification tap routing
- **`_shared/push.ts`** — Expo Push API helper for edge functions
- **`_shared/snapshotJob.ts`** — sends push on snapshot completion (with `completed_notified_at` dedup)
- **`weekly-summary-notify/`** + **`send-notification/`** — new edge functions
- **Migration 014** — `user_settings.notify_weekly_summary`, `notify_refresh_complete`

### Task 5 — Subscription Paywall (RevenueCat)
- **`lib/revenueCat.ts`** — SDK init, entitlement check, offerings, purchase/restore helpers
- **`store/subscriptionStore.ts`** — Zustand store: hydrate from Supabase + RevenueCat, free-snapshot tracking
- **`components/PaywallModal.tsx`** — full-screen paywall with yearly/monthly plan toggle
- **`rc-webhook/`** — RevenueCat server-to-server webhook edge function
- **Server-side gate** in `snapshot-start/index.ts` — enforces free limit before capture
- **Dashboard integration** — `canTakeSnapshot()` check, `incrementFreeUsage()` after success
- **Settings integration** — subscription section with plan display, manage/upgrade buttons
- **Migration 015** — `profiles.rc_customer_id`, `subscription_status`, `subscription_expires_at`, `free_snapshots_used`, `free_snapshot_limit`

### Task 6 — Notification Audit
- **Deferred OS prompt** — first-time users only see the permission dialog after their first snapshot (value moment)
- **Foreground push suppression** — during active capture, `screen=dashboard` pushes are suppressed locally
- **"Coming soon" toggle** — session expiry notification marked as disabled dead toggle
- **Duplicate push prevention** — `completed_notified_at` conditional write in `snapshotJob.ts`
- **Sign-out token clearing** — `unregisterPushToken()` on explicit sign-out

### Task 7 — School Attribution
- **`lib/schools.ts`** — `SCHOOLS` array + `schoolLabel()` helper
- **`components/SchoolPickerModal.tsx`** — bottom-sheet with radio-style options + "Don't ask again"
- **`hooks/useSchoolPrompt.ts`** — auto-prompt logic (show if `!school && !school_do_not_ask`)
- **Dashboard integration** — modal appears on first visit when school is unset
- **Settings integration** — school row in Account section
- **Migration 016** — `profiles.school`, `school_selected_at`, `school_do_not_ask`, `referral_source`

---

## 2. Fixes Applied During This Audit

### Fix 1: Push Token Leaking in Logs
**File:** `lib/notifications.ts` line 113  
**Before:** `console.log('[Notifications] Token:', token);`  
**After:** `console.log('[Notifications] Token registered (redacted).');`  
**Reason:** Full Expo push tokens should not appear in production logs.

### Fix 2: Missing Subscription Hydrate on Warm Sign-In
**File:** `app/_layout.tsx` — `onAuthStateChange` handler  
**Before:** `SIGNED_IN` event fetched `igAccountId` but never called `hydrateSub()`.  
**After:** Added `hydrateSub(session.user.id)` after igAccountId fetch.  
**Reason:** A returning user who taps a magic link while the app is already running would never load their subscription status until the next cold start.

---

## 3. TypeScript Error Report

**Result: 0 errors across 25 files checked.**

Files scanned:
- `app/_layout.tsx`, `app/auth.tsx`, `app/(tabs)/dashboard.tsx`, `app/(tabs)/settings.tsx`
- `lib/notifications.ts`, `lib/revenueCat.ts`, `lib/schools.ts`, `lib/supabase.ts`, `lib/queryClient.ts`
- `hooks/useNotifications.ts`, `hooks/useSnapshotCapture.ts`, `hooks/useSchoolPrompt.ts`, `hooks/useNotificationSettings.ts`, `hooks/useDashboard.ts`, `hooks/useListData.ts`, `hooks/useSnapshotHistory.ts`
- `store/subscriptionStore.ts`, `store/authStore.ts`, `store/adStore.ts`
- `components/PaywallModal.tsx`, `components/SchoolPickerModal.tsx`, `components/ConsentModal.tsx`, `components/RemoveAdsSheet.tsx`, `components/WeeklySummaryCard.tsx`, `components/SnapshotErrorCard.tsx`

---

## 4. Import & Dependency Crosscheck

| Import Path | Used By | Status |
|---|---|---|
| `@/store/subscriptionStore` | `_layout.tsx`, `dashboard.tsx`, `settings.tsx`, `PaywallModal.tsx` | ✅ Clean |
| `@/lib/notifications` | `useNotifications.ts`, `settings.tsx`, `useSnapshotCapture.ts` | ✅ Clean |
| `@/lib/revenueCat` | `subscriptionStore.ts`, `PaywallModal.tsx` | ✅ Clean |
| `@/lib/schools` | `settings.tsx`, `SchoolPickerModal.tsx` | ✅ Clean |
| `@/hooks/useSchoolPrompt` | `dashboard.tsx` | ✅ Clean |
| `@/hooks/useNotifications` | `_layout.tsx` | ✅ Clean |
| `@/components/PaywallModal` | `dashboard.tsx`, `settings.tsx` | ✅ Clean |
| `@/components/SchoolPickerModal` | `dashboard.tsx`, `settings.tsx` | ✅ Clean |

No broken imports, no circular dependencies, no duplicate symbol names.

---

## 5. Startup Flow Verification

```
Cold start
  ├─ hydrateAds()                           fire-and-forget
  ├─ bootstrap()
  │   ├─ getInitialURL()                     check for magic-link deep link
  │   ├─ handleAuthDeepLink()                PKCE exchange (10 s timeout race)
  │   ├─ getSession()                        read stored session
  │   ├─ conditional refreshSession()        only if expiring < 60 s
  │   ├─ setSession()
  │   ├─ fetch igAccountId                   ig_accounts query
  │   ├─ hydrateSub()                        RevenueCat + Supabase profile
  │   └─ setInitialised()                    ALWAYS (in finally block)
  │
  ├─ useNotifications()
  │   └─ waits for initialised + session + igAccountId
  │       └─ registerForPushNotificationsIfGranted()   (silent — no OS dialog)
  │
  └─ AuthGuard
      └─ waits for initialised
          ├─ no session → /(auth)/sign-in
          ├─ session + no igAccountId → /(auth)/connect-instagram
          └─ session + igAccountId → /(tabs)/dashboard

Warm magic-link sign-in
  ├─ URL listener → handleAuthDeepLink()
  └─ onAuthStateChange(SIGNED_IN)
      ├─ setSession()
      ├─ fetch igAccountId
      └─ hydrateSub()                        ← FIXED in this audit

Sign-out (explicit, via Settings)
  ├─ unregisterPushToken()                   clears push_token in DB
  ├─ supabase.auth.signOut()
  └─ onAuthStateChange(null)
      ├─ setIgAccountId(null)
      └─ resetSub()                          clears subscription state
```

**Verdict:** No race conditions. No stale flag issues. `setInitialised()` is guaranteed. Subscription hydrate is idempotent (RevenueCat `_configured` guard prevents double-init).

---

## 6. Debug Logging Audit

| Area | Count | Verdict |
|---|---|---|
| `_layout.tsx` (auth bootstrap) | 9 logs | **Keep** — tagged `[Auth]`, critical for field debugging |
| `auth.tsx` | 1 warn | **Keep** — timeout fallback |
| `notifications.ts` | 7 logs | **Keep** — token now redacted, rest covers registration lifecycle |
| `useNotifications.ts` | 2 logs | **Keep** — error + tap debug |
| `revenueCat.ts` | 3 logs | **Keep** — config + entitlement errors |
| `subscriptionStore.ts` | 3 logs | **Keep** — hydration troubleshooting |
| Edge functions (`_shared/`) | ~25 logs | **Keep** — essential for Supabase function logs |

All client-side logs use consistent `[Tag]` prefixes. No loops, no render-frequency logs, no token exposure.

---

## 7. Known Limitations (Unchanged)

1. **Forced sign-out (expired refresh token)** does not call `unregisterPushToken()` — only explicit Settings sign-out clears the push token. Stale tokens in the DB are harmless (Expo rejects them) and get overwritten on next sign-in.
2. **Session expiry notification toggle** is disabled ("Coming soon") — the `notify_on_token_expiry` column does not exist; the toggle is cosmetic.
3. **`admin-reset-quota`** edge function is still deployed — should be removed or secret-guarded before wide release.
4. **`@ts-expect-error`** in `PaywallModal.tsx` → `purchasePackage` call — RevenueCat type mismatch between `@8` JS types and React Native wrapper. Works at runtime.

---

## 8. Manual QA Checklist

### Auth & Onboarding
- [ ] **Fresh install → Sign In** — enter email, receive magic link email, tap link, app opens and lands on Connect Instagram
- [ ] **Magic link timeout** — with airplane mode, tap magic link → spinner → 15 s timeout → "Try again" button
- [ ] **Session persistence** — kill app, reopen → lands on dashboard (no re-sign-in)
- [ ] **Warm magic link** — with app already open on sign-in screen, tap magic link from email → session established
- [ ] **Token refresh** — wait > 55 min, open app → session refreshes silently (no sign-out)

### Instagram Connection
- [ ] **Valid cookie** — paste valid session cookie → spinner → lands on Dashboard
- [ ] **Invalid cookie** — paste junk → error message, stays on Connect screen
- [ ] **Expired session (server)** — from Dashboard, trigger capture → SnapshotErrorCard with "Reconnect" if `token_expired`

### Snapshot Capture
- [ ] **First free snapshot** — tap "Daily Snapshot" → progress card appears → completes → metrics update
- [ ] **Paywall after free limit** — tap "Daily Snapshot" again → Alert: "Upgrade to Pro" → PaywallModal opens
- [ ] **Pro user** — subscribe → can take unlimited snapshots
- [ ] **1-hour cooldown** — after a snapshot, button shows countdown timer
- [ ] **Large account (>1000 followers)** — progress card shows phase transitions (followers → following → finalize)
- [ ] **Tap the Dot game** — "Play while loading" button appears during capture → game works, score persists
- [ ] **Kill app during capture** — reopen → can start new capture (stale job doesn't block)

### Push Notifications
- [ ] **No dialog on first launch** — open app for the first time → no OS notification permission dialog
- [ ] **Dialog after first snapshot** — complete first capture → OS permission dialog appears
- [ ] **Snapshot complete push** — when app is backgrounded, snapshot completes → push received with correct text
- [ ] **Foreground suppression** — during active capture, no "snapshot complete" push toast
- [ ] **Notification tap → dashboard** — receive push in system tray → tap → app opens on Dashboard
- [ ] **Toggle off "Refresh complete"** — Settings → Notifications → disable → next snapshot produces no push
- [ ] **Silent re-registration** — sign out → sign in again → push token re-saved (verify in Supabase profiles)
- [ ] **Sign-out clears token** — sign out via Settings → `profiles.push_token` is NULL in DB

### Subscription Paywall
- [ ] **PaywallModal — yearly/monthly toggle** — both plans show correct pricing
- [ ] **Purchase flow** — tap Subscribe → App Store / Play Store sheet → complete → modal closes, `isPro = true`
- [ ] **Restore purchases** — fresh install → sign in → Settings → "Restore Purchases" → pro status restored
- [ ] **Webhook sync** — after purchase, check Supabase `profiles.subscription_status = 'active'`
- [ ] **Cancellation** — cancel in App Store → after period ends, `subscription_status = 'expired'` via webhook
- [ ] **Free counter persists** — use free snapshot, kill app, reopen → counter still shows 1 used / 1 limit

### School Attribution
- [ ] **First visit prompt** — new user lands on Dashboard → SchoolPickerModal appears after data loads
- [ ] **Select school** — pick a school → modal closes, `profiles.school` updated in DB
- [ ] **"Don't ask again"** — tap "Don't ask again" → modal closes, never shows again (`school_do_not_ask = TRUE`)
- [ ] **Change school in Settings** — Settings → Account → School row → picker opens → select different school
- [ ] **School label** — Settings shows human-readable school name, not the code

### Notifications Settings
- [ ] **Three active toggles** — Weekly summary, Refresh complete, New follower alert — all toggle correctly
- [ ] **"Coming soon" toggle** — Session expiry toggle is grayed out, shows "Coming soon" label
- [ ] **Toggle persists on restart** — flip a toggle, kill app, reopen Settings → toggle state is preserved

### Ads & Consent
- [ ] **Banner ad visible** — unless ads removed or consent declined
- [ ] **Interstitial frequency cap** — fires every 3rd list view open
- [ ] **Remove Ads flow** — rewarded video → ads hidden for 24 h
- [ ] **Consent modal** — first launch → consent sheet → accept/decline persists

### Settings Screen
- [ ] **Subscription section visible** — shows current plan + manage/upgrade CTA
- [ ] **Disconnect Instagram** — soft-deletes account, lands on Connect screen
- [ ] **Delete all data** — removes all user data, signs out
- [ ] **Privacy policy / Terms links** — open in browser

---

## 9. Migrations to Apply (in order)

| # | File | What It Adds |
|---|---|---|
| 014 | `014_notification_settings.sql` | `user_settings.notify_weekly_summary`, `notify_refresh_complete` |
| 015 | `015_subscription_tracking.sql` | `profiles.rc_customer_id`, `subscription_status`, `subscription_expires_at`, `free_snapshots_used`, `free_snapshot_limit` + index |
| 016 | `016_school_attribution.sql` | `profiles.school`, `school_selected_at`, `school_do_not_ask`, `referral_source` + index |

**Apply with:**
```bash
npx supabase db push
```

Or individually:
```bash
npx supabase migration up --target 014
npx supabase migration up --target 015
npx supabase migration up --target 016
```

---

## 10. Edge Functions to Deploy

| Function | New/Updated | Notes |
|---|---|---|
| `send-notification` | **New** | Generic push notification sender |
| `weekly-summary-notify` | **New** | Cron-triggered weekly follower summary push |
| `rc-webhook` | **New** | RevenueCat subscription lifecycle webhook |
| `snapshot-start` | **Updated** | Added free-snapshot server-side gate |
| `snapshot-continue` | **Updated** | (Unchanged API; updated shared modules) |
| `_shared/push.ts` | **New** | Expo Push API helper |
| `_shared/snapshotJob.ts` | **Updated** | Completion push + dedup + conditional write |
| `_shared/notify.ts` | **New** | Email (Resend) + push multiplexer |

**Deploy all:**
```bash
npx supabase functions deploy send-notification --no-verify-jwt
npx supabase functions deploy weekly-summary-notify --no-verify-jwt
npx supabase functions deploy rc-webhook --no-verify-jwt
npx supabase functions deploy snapshot-start --no-verify-jwt
npx supabase functions deploy snapshot-continue --no-verify-jwt
```

---

## 11. Configuration / Secrets Required

| Secret | Where to Set | Purpose |
|---|---|---|
| `RC_PUBLIC_KEY_IOS` | App env / `lib/revenueCat.ts` | RevenueCat iOS public API key |
| `RC_PUBLIC_KEY_ANDROID` | App env / `lib/revenueCat.ts` | RevenueCat Android public API key |
| `RC_WEBHOOK_SECRET` | Supabase Vault + RevenueCat dashboard | Shared HMAC secret for webhook auth |
| `RESEND_API_KEY` | Supabase Vault | Resend API key for weekly summary emails |
| Expo Push credentials | Managed by EAS | Push notification certificates |
| RevenueCat products | App Store Connect & Play Console | `stayreel_pro_yearly`, `stayreel_pro_monthly` |
| RevenueCat offering | RevenueCat dashboard | Default offering with yearly + monthly packages |

---

## 12. npm Dependencies Added

| Package | Version | Purpose |
|---|---|---|
| `react-native-purchases` | `^8.x` | RevenueCat SDK for subscription management |
| `expo-notifications` | (Expo SDK 54) | Push notification registration + handling |

Both are already in `package.json`. No additional install needed.
