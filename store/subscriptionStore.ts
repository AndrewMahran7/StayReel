// store/subscriptionStore.ts
// Tracks subscription status and free-snapshot usage.
// Hydrated from Supabase profile + RevenueCat on app launch.
// Used by lists and dashboard for freemium gating (lists are gated, snapshots are free).

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import {
  configureRevenueCat,
  hasProEntitlement,
  getActiveProductId,
  ENTITLEMENT_ID,
  isProFromInfo,
  isRevenueCatConfigured,
  addCustomerInfoListener,
  syncReferralAttribute,
} from '@/lib/revenueCat';
import { isBetaActive } from '@/lib/betaAccess';
import type { CustomerInfo } from 'react-native-purchases';

// ── Constants ──────────────────────────────────────────────────
// Freemium model: snapshots are unlimited (within rate limits).
// The paywall gates *list visibility* instead of snapshot access.
const FREE_SNAPSHOT_LIMIT = 999;
const LOCAL_KEY = '@stayreel:free_snapshots_used';

/** Maps backend promo error codes to user-friendly messages. */
function promoErrorMessage(code: string): string {
  switch (code) {
    case 'code_not_found':
    case 'code_expired':
    case 'code_inactive':
    case 'code_exhausted':
      return 'That code is invalid or expired.';
    case 'already_redeemed':
      return "You've already redeemed this code.";
    case 'already_pro':
      return 'You already have an active subscription!';
    case 'BAD_REQUEST':
      return 'Please enter a valid promo code.';
    case 'UNAUTHORIZED':
      return 'Please sign in and try again.';
    case 'INTERNAL_ERROR':
    case 'DB_ERROR':
      return 'Something went wrong on our end. Please try again in a moment.';
    default:
      console.warn(`[promoErrorMessage] Unmapped error code: "${code}"`);
      return 'Something went wrong. Please try again.';
  }
}

// ── Types ──────────────────────────────────────────────────────
export type SubStatus = 'free' | 'trial' | 'active' | 'expired' | 'cancelled';
export type PlanSource = 'monthly' | 'annual' | 'trial' | 'promo' | 'beta' | 'free';

export interface EffectivePlan {
  hasProAccess: boolean;
  source:       PlanSource;
  planLabel:    string;
  expiresAt:    string | null;
}

export interface SubscriptionState {
  // Status
  isPro:              boolean;
  status:             SubStatus;
  expiresAt:          string | null;

  // Promo access (server-managed, separate from RC subscriptions)
  promoUntil:         string | null;

  // RC product identifier (set from CustomerInfo when available)
  rcProductId:        string | null;

  // Free snapshot tracking
  freeSnapshotsUsed:  number;
  freeSnapshotLimit:  number;

  // Hydration
  hydrated:           boolean;

  // Derived plan (unified source of truth for display + gating)
  effectivePlan:      () => EffectivePlan;

  // Actions
  hydrate:            (userId: string) => Promise<void>;
  setProFromInfo:     (info: CustomerInfo) => void;
  redeemPromo:        (code: string) => Promise<{ ok: boolean; message: string; grantsUntil?: string }>;
  incrementFreeUsage: () => Promise<void>;
  canTakeSnapshot:    () => boolean;
  reset:              () => void;

  /** Unsubscribe from RC customer info listener (called on sign-out). */
  _unsubListener:     (() => void) | null;
}

// ── Store ──────────────────────────────────────────────────────
export const useSubscriptionStore = create<SubscriptionState>()((set, get) => ({
  isPro:             false,
  status:            'free',
  expiresAt:         null,
  promoUntil:        null,
  rcProductId:       null,
  freeSnapshotsUsed: 0,
  freeSnapshotLimit: FREE_SNAPSHOT_LIMIT,
  hydrated:          false,
  _unsubListener:    null,

  /**
   * Derive the effective plan from current store state.
   * Single source of truth for plan label, source, and gating.
   */
  effectivePlan(): EffectivePlan {
    const { isPro, status, expiresAt, promoUntil, rcProductId } = get();

    // Beta access overrides everything — all users get Pro during beta
    if (isBetaActive()) {
      return { hasProAccess: true, source: 'beta', planLabel: 'Beta Access', expiresAt: null };
    }

    if (!isPro) {
      return { hasProAccess: false, source: 'free', planLabel: 'Free', expiresAt: null };
    }

    // Paid RC subscription takes display priority over promo
    if (rcProductId) {
      const isAnnual = /annual|yearly|year/i.test(rcProductId);
      const isTrial  = status === 'trial';
      return {
        hasProAccess: true,
        source:       isTrial ? 'trial' : (isAnnual ? 'annual' : 'monthly'),
        planLabel:    isTrial ? 'Free Trial' : (isAnnual ? 'Pro Annual' : 'Pro Monthly'),
        expiresAt:    expiresAt,
      };
    }

    // Active promo access
    if (promoUntil) {
      return {
        hasProAccess: true,
        source:       'promo',
        planLabel:    'Pro (Promo)',
        expiresAt:    promoUntil,
      };
    }

    // DB-fallback active subscription (no RC product ID, no promo)
    const isTrial = status === 'trial';
    return {
      hasProAccess: true,
      source:       isTrial ? 'trial' : 'monthly',
      planLabel:    isTrial ? 'Free Trial' : 'Pro',
      expiresAt:    expiresAt,
    };
  },

  /**
   * Hydrate subscription state from Supabase profile + RevenueCat.
   * Call once after auth is established.
   */
  async hydrate(userId: string) {
    try {
      // 1. Configure RevenueCat with the user's Supabase ID
      //    Returns false when the API key is missing/placeholder — in that
      //    case we skip RC calls and fall back to Supabase-only state.
      const rcReady = await configureRevenueCat(userId);

      // 2. Load profile data from Supabase
      const { data: profile } = await supabase
        .from('profiles')
        .select('subscription_status, subscription_expires_at, free_snapshots_used, free_snapshot_limit, referred_by, promo_until')
        .eq('id', userId)
        .maybeSingle();

      // Sync referral attribution to RevenueCat ($campaign attribute)
      // so revenue reports can be grouped by ambassador.
      syncReferralAttribute(profile?.referred_by ?? null);

      const dbUsed  = profile?.free_snapshots_used  ?? 0;
      const dbLimit = profile?.free_snapshot_limit   ?? FREE_SNAPSHOT_LIMIT;

      // 3. Check RevenueCat entitlement (source of truth for subscription)
      //    When RC isn't configured, trust the Supabase profile status instead
      //    so the rest of the app still functions.
      //
      //    IMPORTANT: This is the only place client-side isPro is determined at
      //    launch.  The rule is: RC > DB fallback > default false.
      //    The client must NEVER widen access beyond what the server allows;
      //    it may only apply a more restrictive fallback.
      let isPro = false;
      let proSource: 'rc' | 'db-fallback' | 'promo' | 'none' = 'none';

      // Check promo access first (server-managed, independent of RC)
      const promoUntil = profile?.promo_until ?? null;
      const promoActive = promoUntil && new Date(promoUntil) > new Date();

      // Fetch the RC product id for plan label resolution
      let rcProduct: string | null = null;

      if (promoActive) {
        isPro = true;
        proSource = 'promo';
        // Still grab the RC product so effectivePlan() can detect paid+promo overlap
        if (rcReady) rcProduct = await getActiveProductId();
      } else if (rcReady) {
        isPro = await hasProEntitlement();
        proSource = isPro ? 'rc' : 'none';
        if (isPro) rcProduct = await getActiveProductId();
      } else if (profile?.subscription_status === 'active' || profile?.subscription_status === 'trial') {
        // Fallback: trust the webhook-synced status in the DB.
        // Also verify expiry hasn't passed (mirrors server-side check).
        const expiresAt = profile?.subscription_expires_at;
        const notExpired = !expiresAt || new Date(expiresAt) > new Date();
        isPro = notExpired;
        proSource = isPro ? 'db-fallback' : 'none';
        if (!notExpired) {
          console.warn('[Subscription] DB says active/trial but subscription_expires_at is in the past — treating as free');
        }
      }
      // Beta access: grant Pro to all authenticated users regardless of RC/DB state
      if (isBetaActive() && !isPro) {
        isPro = true;
        proSource = 'beta' as typeof proSource;
      }

      console.log(`[Subscription] proSource=${proSource} isPro=${isPro} rcReady=${rcReady} dbStatus=${profile?.subscription_status ?? 'null'} promoUntil=${promoUntil ?? 'none'} betaActive=${isBetaActive()}`);

      // 4. Also read local storage as a fallback for free usage count
      //    (in case the Supabase fetch had stale data on a slow network)
      const localUsed = parseInt(await AsyncStorage.getItem(LOCAL_KEY) ?? '0', 10);
      const usedCount = Math.max(dbUsed, localUsed);

      set({
        isPro,
        rcProductId:       rcProduct,
        status:            isPro ? (profile?.subscription_status as SubStatus ?? 'active') : 'free',
        expiresAt:         profile?.subscription_expires_at ?? null,
        promoUntil:        promoActive ? promoUntil : null,
        freeSnapshotsUsed: usedCount,
        freeSnapshotLimit: dbLimit,
        hydrated:          true,
      });

      console.log('[Subscription] Hydrated:', {
        isPro,
        usedCount,
        limit: dbLimit,
        status: profile?.subscription_status ?? 'free',
      });

      // 5. Register a real-time listener so purchases / renewals / expirations
      //    update the store immediately without needing an app restart.
      //    IMPORTANT: The listener must not downgrade isPro when an active
      //    promo is in effect — RC doesn't know about promo access.
      const prev = get()._unsubListener;
      if (prev) prev();  // clean up any previous listener
      const unsub = addCustomerInfoListener((info) => {
        const rcPro = isProFromInfo(info);
        const ent   = info.entitlements.active[ENTITLEMENT_ID];

        // Preserve promo-granted access: if RC says free but promo is active,
        // keep isPro = true and don't overwrite promoUntil.
        const currentPromo = get().promoUntil;
        const promoStillActive = currentPromo && new Date(currentPromo) > new Date();

        const effectiveIsPro = rcPro || !!promoStillActive;
        const rcProductId    = ent?.productIdentifier ?? null;

        set({
          isPro:       effectiveIsPro,
          status:      effectiveIsPro ? (rcPro ? 'active' : get().status) : 'free',
          expiresAt:   ent?.expirationDate ?? get().expiresAt,
          rcProductId: rcProductId,
          // promoUntil is NOT cleared here — only cleared by RC webhook on paid upgrade
        });
        console.log(`[Subscription] Listener update — rcPro=${rcPro} promoActive=${!!promoStillActive} effectiveIsPro=${effectiveIsPro} product=${rcProductId}`);
      });
      set({ _unsubListener: unsub });
    } catch (err) {
      console.warn('[Subscription] Hydrate error:', err);
      // Still mark as hydrated so the app doesn't hang
      set({ hydrated: true });
    }
  },

  /**
   * Update store from a fresh CustomerInfo (after purchase / restore).
   * Preserves promo-granted access if RC has no active entitlement.
   */
  setProFromInfo(info: CustomerInfo) {
    const rcPro = isProFromInfo(info);
    const entitlement = info.entitlements.active[ENTITLEMENT_ID];

    // If RC says pro, this is a paid subscription — it takes priority.
    // If RC says free, check if promo is still active before downgrading.
    const currentPromo = get().promoUntil;
    const promoStillActive = currentPromo && new Date(currentPromo) > new Date();
    const effectiveIsPro = rcPro || !!promoStillActive;

    set({
      isPro:       effectiveIsPro,
      status:      effectiveIsPro ? 'active' : 'free',
      expiresAt:   entitlement?.expirationDate ?? (promoStillActive ? currentPromo : null),
      rcProductId: entitlement?.productIdentifier ?? null,
      // If user bought a paid plan, clear promo (clean transition)
      promoUntil:  rcPro ? null : get().promoUntil,
    });
    console.log(`[Subscription] setProFromInfo — rcPro=${rcPro} promoActive=${!!promoStillActive} effectiveIsPro=${effectiveIsPro}`);
  },

  /**
   * Increment the free snapshot counter (after a successful snapshot).
   * Persists to both Supabase and AsyncStorage.
   */
  async incrementFreeUsage() {
    const newCount = get().freeSnapshotsUsed + 1;
    set({ freeSnapshotsUsed: newCount });

    // Persist locally (fast, offline-safe)
    await AsyncStorage.setItem(LOCAL_KEY, String(newCount));

    // Persist to Supabase (best-effort)
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from('profiles')
        .update({ free_snapshots_used: newCount, updated_at: new Date().toISOString() })
        .eq('id', user.id)
        .then(undefined, (err: Error) => console.warn('[Subscription] DB update error:', err.message));
    }
  },

  /**
   * Returns true if the user is allowed to take a snapshot.
   *
   * Freemium model: snapshots are never gated by subscription status.
   * Rate-limits (hourly cooldown, daily cap) are enforced server-side
   * in rate_limit.ts — this method is kept for backward compatibility
   * but always returns true.
   */
  canTakeSnapshot(): boolean {
    return true;
  },

  /**
   * Reset on sign-out.
   */
  /**
   * Redeem a promo code via the edge function.
   * On success, updates isPro and promoUntil immediately.
   */
  async redeemPromo(code: string) {
    try {
      // Read cached session first, then proactively refresh if the
      // token is expired or within 60 s of expiry — identical to the
      // pattern in useDashboard / useSnapshotCapture.
      let { data: { session } } = await supabase.auth.getSession();
      const expiresAt = session?.expires_at ?? 0; // unix seconds
      if (!session?.access_token || (expiresAt * 1_000 - Date.now()) < 60_000) {
        const { data } = await supabase.auth.refreshSession();
        session = data.session;
      }
      if (!session) return { ok: false, message: 'Please sign in and try again.' };

      // Use raw fetch instead of supabase.functions.invoke so we always
      // receive the structured JSON body — the SDK wraps non-2xx responses
      // in a generic error, hiding the real error code and message.
      const url = `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/redeem-promo`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
        },
        body: JSON.stringify({ code }),
      });

      let body: Record<string, any>;
      try {
        const text = await res.text();
        body = JSON.parse(text);
      } catch {
        console.warn('[redeemPromo] Failed to parse response body, status:', res.status);
        // If the edge function isn't deployed or returns HTML, this catches it.
        return { ok: false, message: 'Something went wrong. Please try again later.' };
      }

      // Structured error from our edge function
      if (!res.ok || body.error) {
        const errorCode = body.error ?? 'UNKNOWN';
        // Catch generic Supabase gateway errors (e.g. "Edge Function returned
        // a non-2xx status code") that slip through when the SDK response shape
        // doesn't match our edge function's format.
        const isSdkWrapped =
          typeof body.message === 'string' &&
          body.message.includes('Edge Function') &&
          !body.error;
        if (isSdkWrapped) {
          console.warn(`[redeemPromo] SDK-wrapped error, status=${res.status}`);
          return { ok: false, message: 'Something went wrong. Please try again later.' };
        }
        console.warn(`[redeemPromo] code="${code}" errorCode=${errorCode} status=${res.status}`);
        return { ok: false, message: promoErrorMessage(errorCode) };
      }

      // Success — update store immediately
      set({
        isPro: true,
        rcProductId: get().rcProductId,  // preserve any existing RC product
        status: 'active',
        expiresAt: body.grants_until ?? null,
        promoUntil: body.grants_until ?? null,
      });

      return {
        ok: true,
        message: body.message ?? 'Pro access granted!',
        grantsUntil: body.grants_until,
      };
    } catch (e: any) {
      console.warn('[redeemPromo] Unexpected error:', e?.message);
      return { ok: false, message: 'Something went wrong. Please try again.' };
    }
  },

  reset() {
    const unsub = get()._unsubListener;
    if (unsub) unsub();
    set({
      isPro: false,
      rcProductId: null,
      status: 'free',
      expiresAt: null,
      promoUntil: null,
      freeSnapshotsUsed: 0,
      freeSnapshotLimit: FREE_SNAPSHOT_LIMIT,
      _unsubListener: null,
      hydrated: false,
    });
    AsyncStorage.removeItem(LOCAL_KEY).catch(() => {});
  },
}));
