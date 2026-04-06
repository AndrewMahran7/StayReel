// lib/revenueCat.ts
// RevenueCat SDK v9 initialization, paywall, and customer center helpers.
//
// Products (configure in App Store Connect + Google Play Console + RC dashboard):
//   - monthly    (subscription)
//   - yearly     (subscription)
//   - lifetime   (non-consumable)
//
// Entitlement (configured in RevenueCat dashboard):
//   - "StayReel Pro"
//
// Offering (configured in RevenueCat dashboard):
//   - "default"

import Purchases, {
  LOG_LEVEL,
  type CustomerInfo,
  type PurchasesOffering,
} from 'react-native-purchases';
import RevenueCatUI, { PAYWALL_RESULT } from 'react-native-purchases-ui';
import { Alert, Linking, Platform } from 'react-native';

// ── Configuration ──────────────────────────────────────────────
// StayReel is iOS-only — only the iOS key is used.
const RC_API_KEY_IOS = process.env.EXPO_PUBLIC_RC_API_KEY_IOS ?? '';

export const ENTITLEMENT_ID = 'StayReel Pro';

export const PRODUCT_IDS = {
  monthly:  'monthly',
  yearly:   'yearly',
  lifetime: 'lifetime',
} as const;

// Re-export so consumers don't need a separate import
export { PAYWALL_RESULT };

// ── Key validation helpers ─────────────────────────────────────

const PLACEHOLDER_RE = /YOUR_.*_KEY/i;

/** Known valid key prefixes per platform (test_ works everywhere). */
const KNOWN_PREFIXES: Record<string, string[]> = {
  ios:     ['appl_', 'test_'],
  android: ['goog_', 'test_'],
};

function isKeyUsable(key: string): boolean {
  return key.length > 0 && !PLACEHOLDER_RE.test(key);
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 5) + '…' + key.slice(-3);
}

function looksCorrectForPlatform(key: string, platform: string): boolean {
  const prefixes = KNOWN_PREFIXES[platform];
  if (!prefixes) return true;
  return prefixes.some((p) => key.startsWith(p));
}

// ── Initialization ─────────────────────────────────────────────

let _configured = false;
let _configureError: string | null = null;

/** Whether RevenueCat was actually configured with a usable key. */
export function isRevenueCatConfigured(): boolean {
  return _configured;
}

/** Returns the reason RevenueCat failed to configure, or null if OK/not attempted. */
export function getRevenueCatConfigError(): string | null {
  return _configureError;
}

/**
 * Initialize RevenueCat SDK. Safe to call multiple times — only configures once.
 * Should be called after the user is authenticated so we can set the
 * Supabase user ID as the RC app user ID.
 *
 * Returns `true` if RC was configured, `false` if skipped.
 */
export async function configureRevenueCat(userId: string): Promise<boolean> {
  if (_configured) return true;

  const platform = Platform.OS;

  // StayReel is iOS-only — skip RC entirely on Android/other platforms.
  if (platform !== 'ios') {
    _configureError = 'Purchases are only available on iOS.';
    console.log('[RevenueCat] Skipping configuration on non-iOS platform:', platform);
    return false;
  }

  const apiKey = RC_API_KEY_IOS;

  // ── Startup diagnostic (never logs full key) ─────────────────
  console.log('[RevenueCat] Diagnostic:', {
    platform,
    keyPresent:               apiKey.length > 0,
    keyMasked:                apiKey.length > 0 ? maskKey(apiKey) : '(empty)',
    looksLikeCorrectPlatform: looksCorrectForPlatform(apiKey, platform),
    isPlaceholder:            PLACEHOLDER_RE.test(apiKey),
  });

  // Guard: skip configuration when the key is empty or a placeholder.
  if (!isKeyUsable(apiKey)) {
    _configureError = 'No iOS API key. Set EXPO_PUBLIC_RC_API_KEY_IOS in .env.';
    console.warn(`[RevenueCat] ${_configureError}`);
    return false;
  }

  // Warn (but don't block) if the prefix doesn't match the platform.
  if (!looksCorrectForPlatform(apiKey, platform)) {
    console.warn(
      `[RevenueCat] Key prefix may be wrong for ${platform}. ` +
      `Expected one of: ${(KNOWN_PREFIXES[platform] ?? []).join(', ')}`,
    );
  }

  if (__DEV__) {
    Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  }

  try {
    Purchases.configure({ apiKey, appUserID: userId });
    _configured = true;
    _configureError = null;
    console.log('[RevenueCat] Configured for user:', userId);
    return true;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    _configureError = /simulator|storekit/i.test(msg)
      ? 'StoreKit not available. Purchases require a physical iOS device (not Simulator).'
      : `RevenueCat error: ${msg}`;
    console.warn('[RevenueCat] configure() threw:', msg, '→ stored reason:', _configureError);
    return false;
  }
}

// ── Referral / Ambassador attribution ──────────────────────────

/**
 * Tag the RevenueCat customer with an ambassador referral code.
 * Uses the reserved `$campaign` subscriber attribute so the code
 * appears in RC dashboard charts and webhook payloads.
 *
 * Safe to call multiple times — RC deduplicates identical values.
 * No-ops when RC isn't configured (Android / Simulator).
 */
export function setReferralAttribute(code: string): void {
  if (!_configured) {
    console.log('[RevenueCat] Not configured — skipping setReferralAttribute');
    return;
  }
  try {
    Purchases.setAttributes({ '$campaign': code });
    console.log('[RevenueCat] Set $campaign attribute:', code);
  } catch (err: any) {
    console.warn('[RevenueCat] setAttributes error:', err?.message ?? err);
  }
}

/**
 * Sync the referral attribute on app startup.
 * Called from subscriptionStore.hydrate() which already has the profile data.
 * Pass the `referred_by` value directly to avoid supabase import in this module.
 */
export function syncReferralAttribute(referredBy: string | null): void {
  if (!_configured || !referredBy) return;
  setReferralAttribute(referredBy);
}

// ── Customer info ──────────────────────────────────────────────

/**
 * Fetch the current CustomerInfo from RevenueCat.
 * Returns null when RC is not configured.
 */
export async function getCustomerInfo(): Promise<CustomerInfo | null> {
  if (!_configured) return null;
  try {
    return await Purchases.getCustomerInfo();
  } catch (err) {
    console.warn('[RevenueCat] getCustomerInfo error:', err);
    return null;
  }
}

/**
 * Returns true if the user has an active "StayReel Pro" entitlement.
 * Returns false (instead of throwing) when RC is not configured.
 */
export async function hasProEntitlement(): Promise<boolean> {
  const info = await getCustomerInfo();
  return info ? isProFromInfo(info) : false;
}

/**
 * Returns the active entitlement's product identifier (e.g. "stayreel_pro_monthly")
 * or null if no active subscription exists.
 */
export async function getActiveProductId(): Promise<string | null> {
  const info = await getCustomerInfo();
  if (!info) return null;
  const ent = info.entitlements.active[ENTITLEMENT_ID];
  return ent?.productIdentifier ?? null;
}

/**
 * Extracts pro status from a CustomerInfo object (avoids extra API call).
 */
export function isProFromInfo(info: CustomerInfo): boolean {
  return !!info.entitlements.active[ENTITLEMENT_ID];
}

/**
 * Register a listener for real-time customer info updates (purchase, renewal, expiry).
 * Returns an unsubscribe function.
 */
export function addCustomerInfoListener(
  callback: (info: CustomerInfo) => void,
): () => void {
  if (!_configured) return () => {};
  Purchases.addCustomerInfoUpdateListener(callback);
  return () => Purchases.removeCustomerInfoUpdateListener(callback);
}

// ── Offerings ──────────────────────────────────────────────────

/**
 * Fetches the current offering from RevenueCat.
 * Returns null if RC is not configured or offerings aren't set up yet.
 */
export async function getCurrentOffering(): Promise<PurchasesOffering | null> {
  if (!_configured) return null;
  try {
    const offerings = await Purchases.getOfferings();
    return offerings.current ?? null;
  } catch (err) {
    console.warn('[RevenueCat] getOfferings error:', err);
    return null;
  }
}

// ── Purchases ──────────────────────────────────────────────────

/**
 * Purchase a package. Returns the updated CustomerInfo on success.
 * Throws on cancellation or error (caller should handle).
 */
export async function purchasePackage(
  pkg: { identifier: string } & Record<string, unknown>,
): Promise<CustomerInfo> {
  // @ts-expect-error — PurchasesPackage type mismatch between versions
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
}

/**
 * Restore purchases (for users who reinstalled or switched devices).
 */
export async function restorePurchases(): Promise<CustomerInfo> {
  return Purchases.restorePurchases();
}

// ── Paywall (RevenueCat UI) ────────────────────────────────────

/**
 * Present the RevenueCat native paywall.
 * Only shows if the user doesn't already have the "StayReel Pro" entitlement.
 * Returns the paywall result. Falls back to an Alert when RC isn't configured.
 */
export async function showPaywall(): Promise<PAYWALL_RESULT> {
  if (!_configured) {
    Alert.alert(
      'Purchases Unavailable',
      `In-app purchases are not available right now. ` +
      `Make sure you're on a device with ${Platform.OS === 'android' ? 'Google Play' : 'the App Store'}.`,
    );
    return PAYWALL_RESULT.ERROR;
  }

  try {
    return await RevenueCatUI.presentPaywallIfNeeded({
      requiredEntitlementIdentifier: ENTITLEMENT_ID,
    });
  } catch (err: any) {
    console.warn('[RevenueCat] presentPaywall error:', err?.message ?? err);
    return PAYWALL_RESULT.ERROR;
  }
}

/**
 * Present the RevenueCat native paywall unconditionally (even if user is pro).
 */
export async function showPaywallForce(): Promise<PAYWALL_RESULT> {
  if (!_configured) {
    Alert.alert(
      'Purchases Unavailable',
      'In-app purchases are not available right now.',
    );
    return PAYWALL_RESULT.ERROR;
  }

  try {
    return await RevenueCatUI.presentPaywall();
  } catch (err: any) {
    console.warn('[RevenueCat] presentPaywall error:', err?.message ?? err);
    return PAYWALL_RESULT.ERROR;
  }
}

// ── Customer Center (RevenueCat UI) ────────────────────────────

/**
 * Present the RevenueCat Customer Center for managing subscriptions.
 * Falls back to the platform's subscription settings when RC isn't configured.
 */
export async function showCustomerCenter(): Promise<void> {
  if (!_configured) {
    await openPlatformSubscriptionSettings();
    return;
  }

  try {
    await RevenueCatUI.presentCustomerCenter();
  } catch (err: any) {
    console.warn('[RevenueCat] presentCustomerCenter error:', err?.message ?? err);
    // Fall back to platform subscription management
    await openPlatformSubscriptionSettings();
  }
}

async function openPlatformSubscriptionSettings(): Promise<void> {
  const url =
    Platform.OS === 'ios'
      ? 'https://apps.apple.com/account/subscriptions'
      : 'https://play.google.com/store/account/subscriptions';
  await Linking.openURL(url);
}
