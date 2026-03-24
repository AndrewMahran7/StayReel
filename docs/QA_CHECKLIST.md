# StayReel — Manual QA Checklist (Freemium Model)

> Run on a **physical iOS device** with a Sandbox Apple ID.
> Requires: two email addresses (one fresh, one with prior snapshots).

---

## Prerequisites

- [ ] App built and running via `npx expo run:ios` or TestFlight
- [ ] Sandbox Apple ID configured in Settings → App Store
- [ ] Supabase dashboard open for DB spot-checks
- [ ] RevenueCat dashboard open (Sandbox mode) for entitlement checks

---

## A. Free User — Snapshot Flow

| # | Step | Expected |
|---|---|---|
| A1 | Sign in with a **fresh email** (magic link) | Lands on Dashboard, no data |
| A2 | Tap **Take Snapshot** | Alert: "This takes a few minutes" → tap "Got it" |
| A3 | Observe progress card | 4 stages appear in order: Connecting → Scanning → Comparing → Building |
| A4 | Observe step dots | Dots highlight sequentially; progress bar fills left-to-right |
| A5 | Wait for completion | Progress card disappears, metric cards populate |
| A6 | Tap **Take Snapshot** again immediately | Button shows countdown timer (1h cooldown), not a paywall |
| A7 | Check `funnel_events` table | Rows for `snapshot_started` and `snapshot_completed` with `is_pro: false` |

---

## B. Free User — List Gating

| # | Step | Expected |
|---|---|---|
| B1 | Tap any metric card (e.g. "Not following you back") | Navigates to Lists tab with correct tab selected |
| B2 | Scroll the list | First ≤10 real usernames visible with avatars |
| B3 | Scroll past row 10 | 5 locked teaser rows appear (grey circles, grey bars, lock icons, fading opacity) |
| B4 | Verify locked rows | **No real usernames, no real avatars** — all placeholder graphics |
| B5 | Verify no unfollow button on locked rows | Locked rows are non-interactive (`pointerEvents="none"`) |
| B6 | Observe upgrade card below locked rows | Contextual headline + subtitle matching the active tab |
| B7 | Verify CTA text | "Unlock all N accounts" where N = total count |
| B8 | Verify fine print | "StayReel Pro" label below button |
| B9 | Check `funnel_events` | `locked_rows_seen` event with `list_type`, `visible`, `hidden`, `total` |

---

## C. Free User — Short / Empty Lists

| # | Step | Expected |
|---|---|---|
| C1 | Switch to a tab with **0 results** (e.g. "New" after first snapshot) | Empty state: "Take a second snapshot to see changes" |
| C2 | No locked rows or upgrade card appear | Footer is empty — gating only shows when `isLimited && hiddenCount > 0` |
| C3 | Switch to a tab with **≤10 results** | All rows shown as real `UserListItem`s, no locked rows, no upgrade card |
| C4 | Switch to a tab with **>10 results** | 10 real rows + locked teaser rows + upgrade card |

---

## D. Paywall Opening

| # | Step | Expected |
|---|---|---|
| D1 | On Lists, tap **"Unlock all N accounts"** | PaywallModal opens (full-screen, RevenueCat native UI) |
| D2 | Verify paywall has close button (X or swipe) | Modal is dismissible |
| D3 | Dismiss the paywall | Returns to lists, locked rows still visible |
| D4 | On Dashboard, tap the **soft upgrade CTA** banner | PaywallModal opens |
| D5 | On Settings, tap **"Upgrade to Pro"** | PaywallModal opens |
| D6 | Verify subtitle on Settings row | "See your full follower lists & more" (not "Unlimited snapshots") |
| D7 | Check `funnel_events` | `upgrade_cta_clicked` (from lists) and `paywall_opened` events logged |

---

## E. Successful Purchase

| # | Step | Expected |
|---|---|---|
| E1 | Open paywall → select a plan → confirm sandbox purchase | Apple sandbox payment sheet → authenticate → purchase completes |
| E2 | Paywall closes automatically | Returns to previous screen |
| E3 | Navigate to Lists → previously gated tab | **All rows visible**, no locked rows, no upgrade card |
| E4 | Navigate to Dashboard | Soft upgrade CTA banner is **hidden** |
| E5 | Navigate to Settings | "Current plan" shows **Pro**; "Manage subscription" row visible; "Upgrade to Pro" row hidden |
| E6 | Check `funnel_events` | `purchase_completed` event with `entitlements` array |
| E7 | Check RevenueCat dashboard (Sandbox) | Customer shows active `StayReel Pro` entitlement |
| E8 | Check Supabase `profiles` | `subscription_status = 'active'` (via rc-webhook) |

---

## F. Restored Purchase

| # | Step | Expected |
|---|---|---|
| F1 | Sign out → sign back in with same email | App loads as free user initially |
| F2 | Settings → **Restore Purchases** | RevenueCat checks → entitlement found |
| F3 | Alert: "Your subscription has been restored" | `isPro` flips to true |
| F4 | Lists now show full data, Dashboard hides upgrade CTA | Same as post-purchase state |

---

## G. Pro User — Full Flow

| # | Step | Expected |
|---|---|---|
| G1 | As Pro user, tap **Take Snapshot** | Snapshot runs normally (same staged progress) |
| G2 | After completion, navigate to any list tab | All results visible, no truncation |
| G3 | Search within a list | Search works across all results (not just first 10) |
| G4 | Unfollow button on "Ghost" list | Unfollow button visible and functional on every row |
| G5 | Take 3 snapshots (wait 1h between each) | 4th attempt shows daily cap countdown — **not** a paywall |
| G6 | Check `funnel_events` | `snapshot_started` / `snapshot_completed` with `is_pro: true` |

---

## H. Rate Limits & Cooldowns

| # | Step | Expected |
|---|---|---|
| H1 | Take a snapshot → immediately try again | Button shows `HH:MM:SS` countdown (1h cooldown) |
| H2 | Info text below button | "Next snapshot available in HH:MM:SS" |
| H3 | Complete 3 snapshots within 24h | 4th shows: "Daily limit reached (3 of 3 today). Resets in HH:MM:SS" |
| H4 | Wait for cooldown to expire | Button re-enables, "Take Snapshot" label returns |
| H5 | Check server `audit_events` | `rate_limit_hit` events with `limit_type: hourly_cooldown` or `daily_cap` |

---

## I. Review Prompt

| # | Step | Expected |
|---|---|---|
| I1 | Fresh user, 1 snapshot only → open Ghost list with results | **No review prompt** (gate: ≥2 snapshots) |
| I2 | Same user, complete 2nd snapshot → open Ghost list with results | After ~3s, **native App Store review dialog appears** |
| I3 | Dismiss dialog → switch to Lost tab with results | **No second prompt** (session guard) |
| I4 | Force-close app → reopen → open Ghost list again | **No prompt** (60-day cooldown active) |
| I5 | Open "New" tab (not a high-value list) with results | **No prompt** (gate: must be Ghost, Lost, or Secret Fans) |
| I6 | Check `funnel_events` | `review_prompt_shown` with `list_type`, `item_count`, `prompt_number` |

---

## J. Snapshot Loading UX

| # | Step | Expected |
|---|---|---|
| J1 | Start a snapshot, observe the progress card | "Keep StayReel open" warning with info icon |
| J2 | Stage 1 | "Connecting to Instagram…" / "Establishing a secure session" |
| J3 | Stage 2 | "Scanning your followers…" / "X of ~Y followers" (or "X followers so far") |
| J4 | Stage 3 | "Comparing relationships…" / "Using cached following list ✓" or "X following so far" |
| J5 | Stage 4 | "Building your report…" / "Crunching the numbers" |
| J6 | Tap "Play while loading" card | Tap the Dot game opens, live snapshot status pill visible |
| J7 | Snapshot completes while game is open | In-game toast: "Done! ✓" |
| J8 | Close game → dashboard shows updated metrics | Cards populated with new counts |

---

## K. Edge Cases

| # | Step | Expected |
|---|---|---|
| K1 | Kill app mid-snapshot → reopen | Can start a new snapshot (stale job auto-cleaned after 10min) |
| K2 | Sign out → sign in as different user | Subscription store resets, correct plan shown for new user |
| K3 | Expired subscription (sandbox auto-cancel) | Lists re-gate, upgrade CTA reappears, `isPro` flips to false |
| K4 | No Instagram connected → Dashboard | Empty state: "Tap Take Snapshot to capture your first snapshot" — but Connect Instagram should be required first |
| K5 | Airplane mode → take snapshot | Error shown in SnapshotErrorCard, no crash |
| K6 | Airplane mode → open Lists tab | Error banner or cached data (depending on cache state) |
| K7 | RevenueCat unavailable (no API key) | PaywallModal shows fallback "Purchases Unavailable" screen with close button |
| K8 | Analytics failure (funnel_events table missing) | App continues normally — `trackEvent` silently catches errors |

---

## L. Ad & Consent Sanity

| # | Step | Expected |
|---|---|---|
| L1 | Free user sees banner ads on Dashboard and Lists | Ads visible |
| L2 | Pro user — banner ads are shown (unless Remove Ads is separate) | Verify expected behavior matches your ad policy |
| L3 | ATT prompt appears before first ad | Consent system works correctly |

---

## Sign-off

| Area | Pass? | Notes |
|---|---|---|
| Free snapshot flow | ☐ | |
| List gating (10 visible + locked) | ☐ | |
| Short / empty lists | ☐ | |
| Paywall opens from all 3 surfaces | ☐ | |
| Purchase completes & unlocks | ☐ | |
| Restore purchase works | ☐ | |
| Pro user sees full lists | ☐ | |
| Rate limits enforced | ☐ | |
| Review prompt fires correctly | ☐ | |
| Review prompt does not spam | ☐ | |
| Staged loading UX | ☐ | |
| Analytics events logged | ☐ | |
| Edge cases handled gracefully | ☐ | |
