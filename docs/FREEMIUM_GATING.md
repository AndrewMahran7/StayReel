# Freemium Gating — Production Contract & Debug Checklist

> Last updated: 2026-03-24

---

## 1. Sources of Truth (ranked by authority)

| # | Source | Where | Role |
|---|--------|-------|------|
| 1 | **RevenueCat entitlement** | RC SDK on device → RC servers | Primary source for client-side `isPro`. Real-time listener keeps it fresh. |
| 2 | **`profiles.subscription_status`** (Supabase) | DB row, updated by `rc-webhook` | Server-side gating in `list-users` edge function. Also the client fallback when RC isn't configured (e.g. Simulator, Android). |
| 3 | **Zustand `isPro`** (`subscriptionStore`) | In-memory, hydrated at launch | Derived from #1 or #2. Used by the client-side safety net in `lists.tsx`. |
| 4 | **Edge function `is_limited` flag** | Returned in every `list-users` response | The server's final word on whether this response was truncated. |

---

## 2. Production Contract

### Rules

1. **Server is authoritative** — the `list-users` edge function decides how many items to return and sets `is_limited`. The client renders what the server sends.

2. **Client may restrict, never widen** — if the client detects that `isPro = false` (from RC or DB fallback) but the server sent `is_limited: false` with `total > 10`, the client clamps visible items to 10 and shows locked rows. It never removes the lock when the server says limited.

3. **Fail-closed** — every ambiguous state resolves to "free":
   - RC not configured → `isPro = false`
   - Hydrate throws → `isPro = false`
   - Unknown RC webhook event → `subscription_status = 'free'`
   - DB profile missing → `isFreeUser = true` in edge function
   - `subscription_expires_at` in the past → treated as expired

4. **No dev/test bypass for Pro** — there is no `__DEV__` or environment flag that silently grants Pro access. The dev sign-in backdoor (`EXPO_PUBLIC_DEV_EMAIL`) is for auth only, not subscription.

### Data flow

```
Purchase → RC SDK → RC webhook → profiles.subscription_status (DB)
                  ↓                              ↓
          Client isPro (RC listener)    Edge function isFreeUser check
                  ↓                              ↓
          Client safety net              Server truncation + is_limited flag
                  ↓                              ↓
                  └──────── lists.tsx renders ────┘
```

---

## 3. Admin/Debug Checklist

Use this to verify whether a specific user is truly Free or Pro.

### A. RevenueCat Dashboard
1. Go to **Customers** → search by Supabase user ID (the `app_user_id`).
2. Check **Entitlements** → look for `StayReel Pro` with status `Active`.
3. Check **Subscription** → verify `expires_date` is in the future (or lifetime).
4. If no customer exists → user never interacted with RC → definitely free.

### B. Supabase Dashboard
1. Open **Table Editor → profiles** → filter by user ID.
2. Check `subscription_status` — should be `active` or `trial` for Pro.
3. Check `subscription_expires_at` — must be `NULL` (lifetime) or future date.
4. If status is `active` but `expires_at` is in the past → **stale data** from a missed webhook. The edge function correctly treats this as free.

### C. Metro / Device Logs
Look for these log lines (always emitted, not `__DEV__`-only):

```
[Subscription] proSource=rc isPro=true rcReady=true dbStatus=active
```
→ Healthy Pro user, RC confirmed.

```
[Subscription] proSource=db-fallback isPro=true rcReady=false dbStatus=active
```
→ RC not configured (Android/Simulator). Trusting DB. Check if DB is correct.

```
[Subscription] proSource=none isPro=false rcReady=false dbStatus=null
```
→ Free user, no RC, no DB status. Expected for new accounts.

```
[useListData] response: { listType: "not_following_back", itemCount: 10, total: 47, is_limited: true }
```
→ Server correctly truncated. Free user sees 10 of 47.

```
[Lists] gating: { isPro: false, serverLimited: true, clientOverride: false, needsClamp: false, isLimited: true, totalCount: 47, itemsReceived: 10, itemsVisible: 10 }
```
→ Normal free-user flow. Server did the work, client agrees.

```
[Lists] gating: { isPro: false, serverLimited: false, clientOverride: true, needsClamp: true, ... itemsReceived: 47, itemsVisible: 10 }
```
→ **Client safety net fired.** Server thought user was Pro (stale DB?) but client knows they're free. Investigate the DB subscription_status.

### D. Edge Function Logs (Supabase Dashboard → Edge Functions → list-users)

```
[list-users] gating: user=abc123 status=active expires=2025-12-01 subActive=false isFree=true total=47 sent=10
```
→ `subActive=false` because `expires` is in the past. Correctly gated despite `status=active`.

### E. Quick Fix: Reset a Stale DB Status

```sql
UPDATE profiles
SET subscription_status = 'free',
    subscription_expires_at = NULL,
    updated_at = now()
WHERE id = '<user-id>';
```

---

## 4. Should the Client Fallback Stay in Production?

**Yes.** Here's why:

1. **Defense in depth** — the server is authoritative but the client is the last line of defense. If the DB has stale `subscription_status = 'active'` from a missed EXPIRATION webhook, the server will serve full lists. The client catches this because it checked RC directly (or defaulted to free when RC isn't available).

2. **Edge function deploy lag** — if a new edge function version with a bug ships, the client fallback prevents data leakage until a hotfix deploys.

3. **Cost is near zero** — it's a single `Array.slice()` and a boolean check. No extra network calls, no UX flicker.

4. **Restriction-only** — the fallback can only hide rows, never reveal them. A Pro user with correct RC entitlement will never be downgraded by it because `isPro = true` disables the override entirely.

5. **Observable** — the `clientOverride: true` and `needsClamp: true` log fields make it immediately obvious when the fallback is active, so you can investigate and fix the root cause.

**When to revisit:** If you add Android/Google Play support with a `goog_` RC key, the fallback becomes less likely to fire (RC will be configured on Android too). But it should still remain as a safety net.
