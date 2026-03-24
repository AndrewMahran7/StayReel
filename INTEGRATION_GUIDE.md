# StayReel iOS Subscription Launch Guide

> **Your exact identifiers — used throughout this guide:**
>
> | Key | Value |
> |-----|-------|
> | Bundle ID | `com.stayreel.ios` |
> | Product IDs | `monthly`, `yearly`, `lifetime` |
> | Entitlement | `StayReel Pro` |
> | RC API key (test) | `test_XTRqKmNezBrzJOaYVquQJcgzkPB` |
> | RC API key (prod) | `appl_…` (from RevenueCat dashboard) |

---

## 1. App Store Connect

### 1A. Paid Applications Agreement

**You cannot sell anything until this is done. Do it first.**

1. Go to [appstoreconnect.apple.com](https://appstoreconnect.apple.com) → **Agreements, Tax, and Banking** (under Business).
2. You'll see "Paid Applications" with status **New** — click **Review**.
3. Fill in:
   - **Bank Info** — routing number, account number, bank name
   - **Tax Info** — complete the US tax forms (W-9 if US-based)
   - **Contact Info** — all required contacts (legal, finance, etc.)
4. Status must show **Active** — not "Processing." Processing can take 1–3 business days.

> **⚠️ PITFALL:** If this is still "Processing" when you submit your app, subscription products will silently fail to load in production. You'll get empty offerings. Apple does not warn you.

---

### 1B. Create the Subscription Group

1. **App Store Connect → Your App → Subscriptions** (left sidebar, under "Monetization").
2. Click **+** next to "Subscription Groups" → name it: **StayReel Pro**.
3. Inside the group, click **Create Subscription** (the + button).

**Monthly subscription:**

| Field | Value |
|-------|-------|
| Reference Name | `StayReel Monthly` |
| Product ID | `monthly` |

After creating, configure:

- **Subscription Duration:** 1 Month
- **Subscription Prices:** Click "Add Subscription Price" → Starting Price → **$2.99 USD** → Apple will auto-calculate all territories → Confirm
- **Free Trial** (optional): Under "Introductory Offers" → click + → Free Trial → 7 Days → make available to all new subscribers
- **Localization:** Click "Add Localization" → English (US) → Display Name: `StayReel Pro Monthly` → Description: `Unlimited follower tracking snapshots.`

**Yearly subscription:**

| Field | Value |
|-------|-------|
| Reference Name | `StayReel Yearly` |
| Product ID | `yearly` |

- **Duration:** 1 Year
- **Price:** $17.99 USD
- **Free Trial:** 7 Days (same as above)
- **Localization:** Display Name: `StayReel Pro Yearly`, Description: same

**Subscription Group Localization:**

Still inside the "StayReel Pro" group header → click **App Store Localization** → Custom Display Name: `StayReel Pro` → Custom App Name: (leave as app name).

> **⚠️ PITFALL:** The Product ID (`monthly`, `yearly`) must **exactly** match what your code references. Case-sensitive. Once created, you cannot change a Product ID.

---

### 1C. Create the Lifetime Purchase (Non-Consumable)

1. **App Store Connect → Your App → In-App Purchases** (under Monetization, separate from Subscriptions).
2. Click **+** → type: **Non-Consumable**.

| Field | Value |
|-------|-------|
| Reference Name | `StayReel Lifetime` |
| Product ID | `lifetime` |

After creating:

- **Price:** Choose your price point (e.g. $49.99). Click "Add Pricing" → select price tier.
- **Localization:** English (US) → Display Name: `StayReel Pro Lifetime` → Description: `One-time purchase for lifetime access.`
- **Review Screenshot:** You **must** upload a screenshot of the purchase in action. Take a Simulator screenshot of your paywall showing the lifetime option. Without this, the product will stay in "Missing Metadata" status.

> **⚠️ PITFALL:** Non-consumables require a review screenshot. Subscriptions do not. If the IAP shows "Missing Metadata," this is almost always the missing screenshot.

---

### 1D. Product Status Checklist

After creating all three, verify each shows status **Ready to Submit**:

| Product | Type | Product ID | Status |
|---------|------|------------|--------|
| StayReel Monthly | Auto-Renewable | `monthly` | Ready to Submit |
| StayReel Yearly | Auto-Renewable | `yearly` | Ready to Submit |
| StayReel Lifetime | Non-Consumable | `lifetime` | Ready to Submit |

Products stay in "Ready to Submit" until you submit the app itself — that's normal.

---

### 1E. Sandbox Tester Setup

1. **App Store Connect → Users and Access** (top nav).
2. Click **Sandbox** in the left sidebar → **Testers**.
3. Click **+** to create a sandbox tester:
   - Use a real email you own but that is **NOT** an existing Apple ID
   - Example: `stayreel.sandbox@gmail.com`
   - Set any name/password
   - Territory: United States
   - App Store Country: United States
4. On your **physical iPhone:** Settings → App Store → scroll to bottom → **Sandbox Account** → sign in with the tester email.
   - On iOS 16+, the Sandbox Account section is separate from your real Apple ID.
   - You do **NOT** need to sign out of your real Apple ID.

> **⚠️ PITFALL:** Do NOT use your real Apple ID as a sandbox tester. It will mess up your account. Always create a dedicated sandbox account.

> **⚠️ PITFALL:** Sandbox subscriptions renew on an accelerated schedule:
>
> | Real Duration | Sandbox Duration |
> |---------------|------------------|
> | 1 Week | 3 minutes |
> | 1 Month | 5 minutes |
> | 1 Year | 1 hour |
> | Lifetime | Permanent |
>
> They auto-renew up to **6 times** in sandbox, then expire.

---

## 2. RevenueCat Dashboard

### 2A. Create the Project

1. Go to [app.revenuecat.com](https://app.revenuecat.com) → click **+ New Project**.
2. Project name: **StayReel**.

---

### 2B. Add the iOS App

1. Inside the project → **Apps** → **+ New App**.
2. Platform: **Apple App Store**
3. App name: **StayReel**
4. Apple Bundle ID: `com.stayreel.ios`
5. **App Store Connect App-Specific Shared Secret:**
   - Go to **App Store Connect → Your App → General → App Information** → scroll down to **App-Specific Shared Secret** → click **Manage** → **Generate**.
   - Copy the secret and paste it into RevenueCat.
   - This is how RevenueCat validates receipts with Apple. Without this, purchases will appear to succeed client-side but RevenueCat won't recognize them.

> **🚨 CRITICAL:** The shared secret is the #1 silent failure point. If it's wrong or missing, `getCustomerInfo()` will return **empty entitlements** even after a successful purchase.

---

### 2C. Get Your iOS Public SDK Key

1. RevenueCat dashboard → your project → **API Keys** (left sidebar).
2. You'll see two types:
   - **Public app-specific key** (starts with `appl_`) — this goes in `EXPO_PUBLIC_RC_API_KEY_IOS`
   - **Secret key** (starts with `sk_`) — **NEVER** put this in your app
3. Copy the `appl_` key.
4. In your `.env` file, replace the test key:
   ```
   EXPO_PUBLIC_RC_API_KEY_IOS=appl_xxxxxxxx
   ```

**How to verify it's correct:**

- It starts with `appl_` (not `goog_`, `sk_`, or `test_`)
- It's from the same RevenueCat project that has your `com.stayreel.ios` app

> Keep `test_XTRqKmNezBrzJOaYVquQJcgzkPB` during development. Switch to `appl_` before your production build.

---

### 2D. Create Products in RevenueCat

1. Dashboard → **Products** (left sidebar) → **+ New**.
2. Create three products:

| Identifier | App Store Product ID | App |
|------------|---------------------|-----|
| `monthly` | `monthly` | StayReel (Apple) |
| `yearly` | `yearly` | StayReel (Apple) |
| `lifetime` | `lifetime` | StayReel (Apple) |

- The "Identifier" in RevenueCat typically matches your App Store Product ID.
- Select the Apple App Store app you created in step 2B.

---

### 2E. Create the Entitlement

1. Dashboard → **Entitlements** (left sidebar) → **+ New**.
2. Identifier: **`StayReel Pro`** (exactly this — must match `ENTITLEMENT_ID` in your code).
3. After creating, click into it → **Attach Products:**
   - ✅ `monthly`
   - ✅ `yearly`
   - ✅ `lifetime`
4. Save.

This means: buying **any** of the three products grants the `StayReel Pro` entitlement.

---

### 2F. Create the Offering

1. Dashboard → **Offerings** (left sidebar) → **+ New**.
2. Identifier: **`default`** — this auto-becomes the "Current Offering."
3. Inside the offering, create **Packages:**

| Package Type | Product |
|-------------|---------|
| `$rc_monthly` | `monthly` |
| `$rc_annual` | `yearly` |
| `$rc_lifetime` | `lifetime` |

- Use the built-in package types (the `$rc_` prefixed ones) — RevenueCat Paywalls require these standard types to auto-populate pricing.
- Click **Save** after adding each package.
- After all three are added, make sure this offering is marked as **Current** (green badge). If not, click **Make Current**.

---

### 2G. Set Up a Paywall

1. Dashboard → **Paywalls** (left sidebar) → **+ Create Paywall**.
2. Choose a template (RevenueCat has several built-in designs).
3. Configure:
   - **Offering:** select `default`
   - **Header/Title:** "Unlock StayReel Pro" (or whatever you want)
   - **Features list:** Add your value props
   - **CTA button text:** "Start Free Trial" or "Subscribe"
   - **Packages to show:** Monthly, Yearly, Lifetime — reorder as desired (yearly first is best practice for higher LTV)
   - **Colors/fonts:** Customize to match your app
4. Click **Publish** when done.

Your app code (`RevenueCatUI.Paywall`) will automatically render this paywall. You can update it from the dashboard **without a new app release**.

> **Note:** Since `PaywallModal.tsx` uses `RevenueCatUI.Paywall` (the native RC component), the paywall you design in the dashboard **IS** what users see. You don't need any custom paywall UI.

---

### 2H. Set Up Customer Center

1. Dashboard → **Customer Center** (left sidebar).
2. This lets subscribers manage their subscription (cancel, change plan, get help) without leaving your app.
3. Configure:
   - **Paths:** Enable/disable management options (Cancel, Change Plan, Missing Purchase, etc.)
   - **Support:** Add your support email
   - **Appearance:** Customize colors
4. **Publish** when ready.

Your code already calls `RevenueCatUI.presentCustomerCenter()` from Settings → "Manage subscription." Once you publish a Customer Center config in the dashboard, it will render automatically.

> **Tip:** Customer Center is most valuable **after launch**, when you have paying subscribers who need self-service options. It reduces support emails. But set it up now so it's ready.

---

### 2I. Testing in RevenueCat

**Sandbox testing:**

1. Dashboard → top right → switch to **Sandbox mode** (toggle).
2. Make a purchase on your test device.
3. Check **Customers** → search by your Supabase user ID.
4. You should see:
   - Active subscription visible
   - `StayReel Pro` entitlement active
   - Transaction history

**Debugging tools:**

- Dashboard → **Customers** → search user → see full transaction history
- Dashboard → **Charts** → see revenue, active subscribers, churn (after launch)

---

## 3. Supabase Webhook Integration

### 3A. Generate a Webhook Secret

Create a strong random string to use as your shared secret:

```bash
openssl rand -hex 32
```

Or use any password generator. Example result: `a1b2c3d4e5f6...` (64 hex chars).

---

### 3B. Store the Secret in Supabase

1. Go to [supabase.com](https://supabase.com) → your project dashboard.
2. **Edge Functions → Secrets** (or go to Settings → Edge Functions).
3. Add a new secret:
   - **Name:** `RC_WEBHOOK_SECRET`
   - **Value:** the random string you generated

Your webhook code reads this via `Deno.env.get("RC_WEBHOOK_SECRET")`.

---

### 3C. Deploy the Webhook Function

```bash
supabase functions deploy rc-webhook --no-verify-jwt
```

The `--no-verify-jwt` is essential because RevenueCat sends its own auth (Bearer token), not a Supabase JWT.

Your deployed URL will be:

```
https://ipepfknhliwuomlsezdt.supabase.co/functions/v1/rc-webhook
```

---

### 3D. Configure the Webhook in RevenueCat

1. RevenueCat Dashboard → **Integrations** (left sidebar) → **Webhooks**.
2. Click **+ New Webhook**.
3. Configure:

| Field | Value |
|-------|-------|
| URL | `https://ipepfknhliwuomlsezdt.supabase.co/functions/v1/rc-webhook` |
| Authorization header | `Bearer <your-random-secret-from-3A>` |

4. Events to send: **Select All events** (your webhook code handles filtering).
5. Click **Save**.

---

### 3E. Test the Webhook

1. In RevenueCat webhook settings, click **Send Test Event**.
2. Check your Supabase Edge Function logs:
   - **Supabase Dashboard → Edge Functions → rc-webhook → Logs**
3. You should see: `[rc-webhook] Received TEST event — acknowledged.`
4. If you see a **401 error:** the Bearer token in RevenueCat doesn't match `RC_WEBHOOK_SECRET` in Supabase.

---

### 3F. Events That Matter

Your webhook handles these (already coded in `rc-webhook/index.ts`):

| Event | What happens | DB status |
|-------|-------------|-----------|
| `INITIAL_PURCHASE` | First subscription or lifetime buy | `trial` or `active` |
| `RENEWAL` | Subscription renewed | `active` |
| `CANCELLATION` | User turned off auto-renew | `cancelled` |
| `UNCANCELLATION` | User re-enabled auto-renew | `active` |
| `EXPIRATION` | Subscription period ended | `expired` |
| `BILLING_ISSUE` | Payment failed | `expired` |
| `SUBSCRIPTION_EXTENDED` | Apple extended the sub | `active` |

> **⚠️ PITFALL:** The `app_user_id` in the webhook payload is the Supabase user UUID you pass to `Purchases.configure({ appUserID: userId })`. If this doesn't match the `id` column in your `profiles` table, the `.eq("id", userId)` will silently update 0 rows.

---

## 4. End-to-End Testing Flow

### 4A. Prerequisites

- Physical iPhone (subscriptions don't work in Simulator)
- Sandbox tester signed in on the device (Settings → App Store → Sandbox Account)
- App running via `npx expo run:ios` or a dev build
- RevenueCat configured with the test key (`test_XTRqKmNezBrzJOaYVquQJcgzkPB`)

---

### 4B. Test Purchase Flow — Step by Step

1. **Open the app** → sign in → you should see RevenueCat config logs in the console.
2. **Take your free snapshot** → completes → paywall appears after 3 seconds.
3. **Tap a plan** on the paywall → Apple's sandbox payment sheet appears → confirm with the sandbox account password → Pay.
4. **After purchase:**
   - `onPurchaseCompleted` fires → `setProFromInfo` updates store → `isPro: true`
   - Paywall closes
   - Console: `[Subscription] Listener update — isPro: true`
5. **Verify in RevenueCat Dashboard** (switch to Sandbox mode):
   - Customers → search your user UUID
   - Should show active `StayReel Pro` entitlement
   - Transaction visible in history
6. **Verify webhook fired** (Supabase logs):
   - Edge Functions → rc-webhook → Logs
   - Should see: `[rc-webhook] INITIAL_PURCHASE for user <uuid>`
   - Check `profiles` table: `subscription_status = 'active'` (or `'trial'` if on trial)

---

### 4C. Test Renewal

- Sandbox monthly renews every **5 minutes**, up to 6 times.
- Just wait — check RevenueCat dashboard and Supabase logs.
- You should see `RENEWAL` events in the webhook logs.

---

### 4D. Test Expiration

1. After 6 sandbox renewals, the subscription expires.
2. Or: **App Store Connect → Sandbox Testers** → click your tester → Manage Subscriptions → **Cancel**.
3. After cancellation + next renewal period passes:
   - `EXPIRATION` event fires
   - `subscription_status → expired` in your DB
   - App should show `isPro: false` on next launch/refresh

---

### 4E. Test Restore Purchases

1. Sign out of the app.
2. Sign back in with the same account.
3. Go to **Settings → "Restore Purchases"**.
4. Should restore the entitlement without re-purchasing.

---

### 4F. Common Test Errors

| Error | Cause | Fix |
|-------|-------|-----|
| "Cannot connect to iTunes Store" | Not signed into sandbox account | Device Settings → App Store → Sandbox Account |
| Paywall shows no packages | Products not created in ASC, or Offering not set up in RC | Verify all 3 products exist + offering has packages |
| Purchase succeeds but `isPro` stays false | Entitlement name mismatch | RC dashboard entitlement must be exactly `StayReel Pro` |
| "No Active Subscription" on restore | Wrong `appUserID` between sessions | Ensure you pass the same Supabase UUID consistently |
| Webhook returns 401 | Secret mismatch | Compare Bearer token in RC dashboard with `RC_WEBHOOK_SECRET` in Supabase |
| Webhook returns 500 | `profiles` row doesn't exist for the user | Ensure user has a profile row before purchase |

---

## 5. Launch Readiness Checklist

### 5A. App Store Submission Requirements

Apple will reject your app if any of these are missing:

- ✅ **Restore Purchases button** — must be accessible without purchasing first. Your Settings screen has this.
- ✅ **Terms of Service link** — visible before purchase and in Settings.
- ✅ **Privacy Policy link** — same as above.
- ✅ **Subscription terms in the paywall** — auto-renewal terms, pricing, and cancellation info must be visible near the purchase button. RevenueCat Paywalls include this automatically.
- ✅ **No "pay to unlock basic functionality"** — Apple may reject if free users get essentially nothing. Your app gives 1 free snapshot, which demonstrates value.

---

### 5B. Pre-Submission Checklist

**App Store Connect:**

- [ ] Paid Applications Agreement status is **Active** (not Processing)
- [ ] All 3 products are in "Ready to Submit" status
- [ ] `monthly` and `yearly` have price, duration, and localization set
- [ ] `lifetime` has price, localization, **AND** a review screenshot uploaded
- [ ] Subscription group "StayReel Pro" has App Store Localization set
- [ ] At least 1 sandbox tester created

**RevenueCat Dashboard:**

- [ ] iOS app added with correct bundle ID (`com.stayreel.ios`)
- [ ] App-Specific Shared Secret from App Store Connect is entered
- [ ] 3 products created and linked to correct App Store Product IDs
- [ ] Entitlement `StayReel Pro` created with all 3 products attached
- [ ] Offering `default` is Current, with packages: `$rc_monthly`, `$rc_annual`, `$rc_lifetime`
- [ ] Paywall designed and published
- [ ] Customer Center configured and published
- [ ] Webhook set up and test event succeeds

**Supabase:**

- [ ] `RC_WEBHOOK_SECRET` stored in Edge Function secrets
- [ ] `rc-webhook` function deployed with `--no-verify-jwt`
- [ ] Test webhook event returns 200 in logs

**Your `.env` (for production build):**

- [ ] `EXPO_PUBLIC_RC_API_KEY_IOS` set to the `appl_` key (NOT the test key)
- [ ] Double-check: key is from the correct project and correct platform

**Code / App:**

- [ ] Restore Purchases accessible from Settings (even for non-subscribers)
- [ ] Terms/Privacy links visible in Settings
- [ ] Paywall shows and is dismissible (X button or swipe)
- [ ] App doesn't crash if RC is unavailable (your fallback UI handles this)
- [ ] `ENTITLEMENT_ID` in code matches exactly: `StayReel Pro`
- [ ] `PRODUCT_IDS` in code match exactly: `monthly`, `yearly`, `lifetime`

---

### 5C. Things That Will Get You Rejected

- **No restore purchases option** — always needed, even for non-consumables.
- **Forcing login before showing the paywall** — Apple wants users to see what the app does before requiring account creation. (Your flow: auth → free snapshot → paywall is fine.)
- **No way to cancel** — must either link to system subscription settings or use Customer Center.
- **Paywall with no Terms of Use / Privacy Policy** — RC native paywalls include this automatically.
- **Subscription description doesn't match what the app does** — keep the App Store product descriptions accurate.
- **Not disclosing auto-renewal terms** — the native RC paywall handles this, but if you ever build custom UI, you must include: price, duration, free trial duration, and how to cancel.

---

### 5D. Day-of-Launch Sequence

1. Swap `.env` key: `EXPO_PUBLIC_RC_API_KEY_IOS=appl_xxxxxxxx`
2. Build production: `eas build --platform ios --profile production`
3. Upload to App Store Connect.
4. Fill in app metadata, screenshots, description.
5. Under **"In-App Purchases"** section of the submission: **select all 3 products** to include.
6. Submit for review.
7. After approval: products go live automatically when the app version is released.

> **⚠️ PITFALL:** If you forget to select your IAPs in the submission form, they won't be reviewed and will stay in "Ready to Submit" forever. Always explicitly include them.

---

## Quick Reference Card

| What | Exact Value |
|------|-------------|
| Bundle ID | `com.stayreel.ios` |
| App Store Product IDs | `monthly`, `yearly`, `lifetime` |
| RC Entitlement | `StayReel Pro` |
| RC Offering | `default` |
| RC Packages | `$rc_monthly`, `$rc_annual`, `$rc_lifetime` |
| Webhook URL | `https://ipepfknhliwuomlsezdt.supabase.co/functions/v1/rc-webhook` |
| Webhook auth | `Bearer <your-secret>` |
| Supabase secret name | `RC_WEBHOOK_SECRET` |
| Production iOS key prefix | `appl_` |
| Test key (current) | `test_XTRqKmNezBrzJOaYVquQJcgzkPB` |