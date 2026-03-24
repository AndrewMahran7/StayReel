// lib/notifications.ts
// Push notification registration, token management, and foreground handler setup.
//
// Uses expo-notifications + expo-device to:
//   1. Request notification permission from the OS.
//   2. Obtain an Expo Push Token (via EAS project ID).
//   3. Sync the token to the user's `profiles.push_token` column.
//   4. Configure foreground display behaviour.

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from './supabase';

// ── Foreground suppression flag ─────────────────────────────────
// When the user is actively watching a snapshot capture, suppress
// the server-sent "snapshot ready" push so they don't get a
// redundant banner on top of the live progress UI.
let _suppressSnapshotPush = false;

/** Call with `true` when a capture starts; resets automatically via timeout. */
export function setSuppressSnapshotPush(v: boolean): void {
  _suppressSnapshotPush = v;
}

// ── Foreground handler ─────────────────────────────────────────
// Show notifications even when the app is in the foreground —
// UNLESS the snapshot-ready push is being suppressed.
Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const data = notification.request.content.data as
      Record<string, unknown> | undefined;

    // Suppress snapshot-ready push while user watches live progress
    if (_suppressSnapshotPush && data?.screen === 'dashboard') {
      return {
        shouldShowAlert: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
        shouldShowBanner: false,
        shouldShowList: false,
      };
    }

    return {
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    };
  },
});

// ── Android channel ────────────────────────────────────────────
// Must be created before any notification is sent on Android 8+.
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'StayReel',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#9B4DCA',
  });
}

// ── Token registration ─────────────────────────────────────────

/**
 * Request notification permission, obtain the Expo push token,
 * and upsert it to `profiles.push_token`.
 *
 * Returns the token string on success, or `null` if permission
 * was denied, the device is a simulator, or registration failed.
 *
 * Safe to call on every app launch — the Expo SDK returns the same
 * cached token if nothing changed, and the Supabase upsert is
 * idempotent.
 */
export async function registerForPushNotifications(): Promise<string | null> {
  // Push notifications only work on physical devices
  if (!Device.isDevice) {
    console.log('[Notifications] Skipping — not a physical device.');
    return null;
  }

  // Check / request OS permission
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('[Notifications] Permission not granted.');
    return null;
  }

  await ensureAndroidChannel();

  // Obtain Expo push token
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.warn('[Notifications] No EAS projectId in app.json — cannot register.');
    return null;
  }

  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    console.log('[Notifications] Token registered (redacted).');

    // Persist to profiles table
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      const { error } = await supabase
        .from('profiles')
        .update({ push_token: token, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      if (error) console.warn('[Notifications] Token save error:', error.message);
      else console.log('[Notifications] Token saved to profile.');
    }

    return token;
  } catch (err) {
    console.error('[Notifications] Registration failed:', err);
    return null;
  }
}

/**
 * Re-register silently if permission was already granted.
 *
 * Unlike `registerForPushNotifications()` this will **never** trigger
 * the OS permission dialog — it only syncs the token when the user
 * has already opted in.
 *
 * Call on every app boot so the Expo push token stays current across
 * app-updates and reinstalls.
 */
export async function registerForPushNotificationsIfGranted(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') {
    // User hasn't opted in yet — don't prompt.
    return null;
  }

  // Permission already granted → safe to register silently
  return registerForPushNotifications();
}

/**
 * Check whether OS notification permission has been granted.
 */
export async function hasNotificationPermission(): Promise<boolean> {
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'granted';
}

/**
 * Clears the push token from the user's profile.
 *
 * **Must be called while the Supabase session is still active** (i.e.
 * before `supabase.auth.signOut()`), otherwise the RLS-protected
 * update will silently fail.
 */
export async function unregisterPushToken(): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase
        .from('profiles')
        .update({ push_token: null, updated_at: new Date().toISOString() })
        .eq('id', user.id);
      console.log('[Notifications] Token cleared from profile.');
    }
  } catch (err) {
    console.error('[Notifications] Unregister failed:', err);
  }
}
