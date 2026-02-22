// lib/adUnits.ts
// Exports platform-specific ad unit IDs.
// In development / Expo Go, test unit IDs are always used.
// Swap the real* constants for your production AdMob IDs before release.

import { Platform } from 'react-native';
import Constants from 'expo-constants';

const isDev = __DEV__ || Constants.appOwnership === 'expo';

// ── Test unit IDs (Google-provided) ──────────────────────────

const TEST_BANNER_IOS              = 'ca-app-pub-3940256099942544/2934735716';
const TEST_BANNER_ANDROID          = 'ca-app-pub-3940256099942544/6300978111';
const TEST_INTERSTITIAL_IOS        = 'ca-app-pub-3940256099942544/4411468910';
const TEST_INTERSTITIAL_ANDROID    = 'ca-app-pub-3940256099942544/1033173712';
const TEST_REWARDED_IOS            = 'ca-app-pub-3940256099942544/1712485313';
const TEST_REWARDED_ANDROID        = 'ca-app-pub-3940256099942544/5224354917';

// ── Your production unit IDs ──────────────────────────────────
// Replace with real IDs from AdMob console before going live.

const REAL_BANNER_IOS              = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // 'ca-app-pub-6049273265076763/6459874513';
const REAL_BANNER_ANDROID          = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // Don't have android set up yet
const REAL_INTERSTITIAL_IOS        = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // Don't want intersititial ads
const REAL_INTERSTITIAL_ANDROID    = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // Don't want intersititial ads
const REAL_REWARDED_IOS            = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // 'ca-app-pub-6049273265076763/5071275801';
const REAL_REWARDED_ANDROID        = 'ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY'; // Don't have android set up yet

// ── Resolvers ─────────────────────────────────────────────────

function pick(ios: string, android: string) {
  return Platform.OS === 'ios' ? ios : android;
}

export const AD_UNITS = {
  banner: isDev
    ? pick(TEST_BANNER_IOS, TEST_BANNER_ANDROID)
    : pick(REAL_BANNER_IOS, REAL_BANNER_ANDROID),

  interstitial: isDev
    ? pick(TEST_INTERSTITIAL_IOS, TEST_INTERSTITIAL_ANDROID)
    : pick(REAL_INTERSTITIAL_IOS, REAL_INTERSTITIAL_ANDROID),

  rewarded: isDev
    ? pick(TEST_REWARDED_IOS, TEST_REWARDED_ANDROID)
    : pick(REAL_REWARDED_IOS, REAL_REWARDED_ANDROID),
} as const;
