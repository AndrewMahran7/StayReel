// store/adStore.ts
// Tracks ad-removal state, consent, and interstitial frequency cap.
// adsRemovedUntil is persisted to AsyncStorage so it survives restarts.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const ADS_REMOVED_KEY   = '@stayreel:ads_removed_until';
const CONSENT_KEY       = '@stayreel:ad_consent';    // 'granted' | 'denied' | null
const INTERSTITIAL_KEY  = '@stayreel:interstitial_opens';

export interface AdState {
  // Consent
  consentStatus:       'granted' | 'denied' | 'unknown';
  setConsentStatus:    (s: 'granted' | 'denied') => Promise<void>;

  // Ad removal (rewarded flow)
  adsRemovedUntil:     number | null;   // Unix-ms timestamp
  hydrate:             () => Promise<void>;
  removeAdsForDays:    (days: number) => Promise<void>;

  // Interstitial frequency cap
  // Show interstitial every N list opens OR after snapshot capture.
  listOpenCount:       number;
  incrementListOpens:  () => Promise<number>;
  resetListOpens:      () => Promise<void>;
}

// ── Stable selector — use this everywhere instead of s.adsActive ──
// Computed on read so it's always current regardless of Zustand
// shallow-merge semantics (which would discard a JS getter on set()).
export function selectAdsActive(s: AdState): boolean {
  if (s.consentStatus === 'unknown') return false;
  if (s.adsRemovedUntil && Date.now() < s.adsRemovedUntil) return false;
  return true;
}

export const INTERSTITIAL_EVERY_N_OPENS = 3;

export const useAdStore = create<AdState>()((set, get) => ({
  consentStatus: 'unknown',

  async setConsentStatus(s) {
    set({ consentStatus: s });
    await AsyncStorage.setItem(CONSENT_KEY, s);
  },

  adsRemovedUntil: null,

  async hydrate() {
    const [removedRaw, consentRaw, opensRaw] = await Promise.all([
      AsyncStorage.getItem(ADS_REMOVED_KEY),
      AsyncStorage.getItem(CONSENT_KEY),
      AsyncStorage.getItem(INTERSTITIAL_KEY),
    ]);
    set({
      adsRemovedUntil: removedRaw ? parseInt(removedRaw, 10) : null,
      consentStatus:   (consentRaw as AdState['consentStatus']) ?? 'unknown',
      listOpenCount:   opensRaw   ? parseInt(opensRaw, 10)   : 0,
    });
  },

  async removeAdsForDays(days) {
    const until = Date.now() + days * 24 * 60 * 60 * 1000;
    set({ adsRemovedUntil: until });
    await AsyncStorage.setItem(ADS_REMOVED_KEY, String(until));
  },

  listOpenCount: 0,

  async incrementListOpens() {
    const next = get().listOpenCount + 1;
    set({ listOpenCount: next });
    await AsyncStorage.setItem(INTERSTITIAL_KEY, String(next));
    return next;
  },

  async resetListOpens() {
    set({ listOpenCount: 0 });
    await AsyncStorage.setItem(INTERSTITIAL_KEY, '0');
  },
}));
