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
  ENTITLEMENT_ID,
  isProFromInfo,
  isRevenueCatConfigured,
  addCustomerInfoListener,
  syncReferralAttribute,
} from '@/lib/revenueCat';
import type { CustomerInfo } from 'react-native-purchases';

// ── Constants ──────────────────────────────────────────────────
// Freemium model: snapshots are unlimited (within rate limits).
// The paywall gates *list visibility* instead of snapshot access.
const FREE_SNAPSHOT_LIMIT = 999;
const LOCAL_KEY = '@stayreel:free_snapshots_used';

// ── Types ──────────────────────────────────────────────────────
export type SubStatus = 'free' | 'trial' | 'active' | 'expired' | 'cancelled';

export interface SubscriptionState {
  // Status
  isPro:              boolean;
  status:             SubStatus;
  expiresAt:          string | null;

  // Free snapshot tracking
  freeSnapshotsUsed:  number;
  freeSnapshotLimit:  number;

  // Hydration
  hydrated:           boolean;

  // Actions
  hydrate:            (userId: string) => Promise<void>;
  setProFromInfo:     (info: CustomerInfo) => void;
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
  freeSnapshotsUsed: 0,
  freeSnapshotLimit: FREE_SNAPSHOT_LIMIT,
  hydrated:          false,
  _unsubListener:    null,

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
        .select('subscription_status, subscription_expires_at, free_snapshots_used, free_snapshot_limit, referred_by')
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
      let proSource: 'rc' | 'db-fallback' | 'none' = 'none';
      if (rcReady) {
        isPro = await hasProEntitlement();
        proSource = isPro ? 'rc' : 'none';
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
      console.log(`[Subscription] proSource=${proSource} isPro=${isPro} rcReady=${rcReady} dbStatus=${profile?.subscription_status ?? 'null'}`);

      // 4. Also read local storage as a fallback for free usage count
      //    (in case the Supabase fetch had stale data on a slow network)
      const localUsed = parseInt(await AsyncStorage.getItem(LOCAL_KEY) ?? '0', 10);
      const usedCount = Math.max(dbUsed, localUsed);

      set({
        isPro,
        status:            isPro ? (profile?.subscription_status as SubStatus ?? 'active') : 'free',
        expiresAt:         profile?.subscription_expires_at ?? null,
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
      const prev = get()._unsubListener;
      if (prev) prev();  // clean up any previous listener
      const unsub = addCustomerInfoListener((info) => {
        const nowPro = isProFromInfo(info);
        const ent    = info.entitlements.active[ENTITLEMENT_ID];
        set({
          isPro:     nowPro,
          status:    nowPro ? 'active' : 'free',
          expiresAt: ent?.expirationDate ?? null,
        });
        console.log('[Subscription] Listener update — isPro:', nowPro);
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
   */
  setProFromInfo(info: CustomerInfo) {
    const isPro = isProFromInfo(info);
    const entitlement = info.entitlements.active[ENTITLEMENT_ID];

    set({
      isPro,
      status:    isPro ? 'active' : 'free',
      expiresAt: entitlement?.expirationDate ?? null,
    });
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
  reset() {
    const unsub = get()._unsubListener;
    if (unsub) unsub();
    set({
      isPro: false,
      status: 'free',
      expiresAt: null,
      freeSnapshotsUsed: 0,
      freeSnapshotLimit: FREE_SNAPSHOT_LIMIT,
      _unsubListener: null,
      hydrated: false,
    });
    AsyncStorage.removeItem(LOCAL_KEY).catch(() => {});
  },
}));
