# Beta Access Mode

StayReel ships with a "Beta Access" system that grants Pro-level access to all
authenticated users while the app is growing. The existing RevenueCat /
paywall / promo-code infrastructure is fully preserved and can be re-enabled
with a single flag change.

---

## How it works

| Layer | File | What happens during beta |
|-------|------|--------------------------|
| **Client config** | `lib/betaAccess.ts` | `BETA_ACCESS_ENABLED = true` — single source of truth |
| **Subscription store** | `store/subscriptionStore.ts` | `effectivePlan()` returns `{ hasProAccess: true, source: 'beta', planLabel: 'Beta Access' }`. `hydrate()` sets `isPro = true` for all users. |
| **Server-side gating** | `supabase/functions/list-users/index.ts` | `BETA_ACCESS_ENABLED = true` makes `subActive` always true, so full lists are returned. |
| **Paywall modal** | `components/PaywallModal.tsx` | Intercepted before RC paywall renders; shows a lightweight "Pro is free during beta" message. Tracks `paywall_suppressed` event. |
| **Dashboard** | `app/(tabs)/dashboard.tsx` | Upgrade CTA replaced with "Pro is free during beta" banner. |
| **Lists** | `app/(tabs)/lists.tsx` | "BETA ACCESS" chip shown next to title. Client `isPro = true` means no locked rows. |
| **Settings** | `app/(tabs)/settings.tsx` | Plan shows "Beta Access". Upgrade/promo/restore/manage subscription rows hidden. |

## Interaction with RevenueCat & promo codes

- RevenueCat is still initialised normally for every user. Purchases made
  during beta will still be processed and recorded.
- `effectivePlan()` checks beta *first*, so it takes priority. But the
  underlying `isPro`, `rcProductId`, and `promoUntil` fields are still
  hydrated correctly. When beta ends, the real subscription state resumes
  automatically.
- Promo code redemption still works (`redeemPromo` is unchanged). Any promo
  applied during beta will persist after beta ends.
- Referral attribution (`set-referral`, `$campaign` in RC) is untouched.
- The RC customer-info listener still fires and updates the store.

## Analytics events added

| Event | When |
|-------|------|
| `beta_access_shown` | Dashboard mounts during beta |
| `instagram_connected` | User completes Instagram connection |
| `paywall_suppressed` | Paywall modal opens during beta (no RC paywall shown) |
| `invite_tapped` | (Reserved — for future share flow) |

Existing events (`snapshot_started`, `snapshot_completed`, `list_opened`, etc.)
continue to fire normally.

## Manual Supabase steps

**None required.** The beta flag is purely code-level (client + edge function).
No database migration, no profile column change, no Supabase config update.

## How to disable beta mode later

1. **Client:** Open `lib/betaAccess.ts` and set:
   ```ts
   const BETA_ACCESS_ENABLED = false;
   ```

2. **Server:** Open `supabase/functions/list-users/index.ts` and set:
   ```ts
   const BETA_ACCESS_ENABLED = false;
   ```

3. **Deploy:**
   - Push an OTA update (`eas update`) so the client flag takes effect.
   - Re-deploy the `list-users` edge function (`supabase functions deploy list-users`).

That's it. Two booleans, two deploys. All paywall, RC, promo, and referral
code paths reactivate automatically.

## Risks & edge cases

| Risk | Mitigation |
|------|------------|
| Server and client flags out of sync | Both default to the same value. Always deploy both together. |
| User purchases during beta, then beta ends | RC entitlement is tracked normally; they keep Pro. |
| Promo applied during beta, promo expires after beta ends | Regular promo expiry logic still runs; user falls back to free if no RC sub. |
| Beta flag cached in old OTA bundle | Use `eas update` with a forced update channel to ensure all clients get the new flag promptly. |
| Free-usage counter drifts during beta | `incrementFreeUsage()` still fires for analytics; counter is cosmetic-only (snapshots were already ungated). |
