// hooks/useNotifications.ts
// Boot-time hook that registers for push notifications and handles
// notification taps (deep-links to the appropriate screen).
//
// Call once in the root layout — the hook is a no-op until the user
// is fully authenticated with a connected IG account.

import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/authStore';
import { registerForPushNotificationsIfGranted } from '@/lib/notifications';

export function useNotifications(): void {
  const router = useRouter();
  const { session, igAccountId, initialised } = useAuthStore();
  const didRegister = useRef(false);

  // ── Silently re-register token on boot (returning users only) ──
  // We do NOT call registerForPushNotifications() here because that
  // would trigger the OS permission dialog on first launch — before
  // the user has experienced any value.  Instead we only sync the
  // token when permission was already granted in a previous session.
  // First-time users are prompted after their first snapshot.
  useEffect(() => {
    if (!initialised || !session || !igAccountId) return;
    if (didRegister.current) return;
    didRegister.current = true;

    registerForPushNotificationsIfGranted().catch((err) =>
      console.warn('[useNotifications] Silent registration error:', err),
    );
  }, [initialised, session, igAccountId]);

  // Reset registration flag on sign-out so a new sign-in re-registers
  useEffect(() => {
    if (!session) didRegister.current = false;
  }, [session]);

  // ── Handle notification taps ────────────────────────────────
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        Record<string, unknown> | undefined;

      console.log('[useNotifications] Notification tapped:', data);

      const screen = data?.screen as string | undefined;

      switch (screen) {
        case 'dashboard':
          router.push('/(tabs)/dashboard');
          break;
        case 'lists':
          router.push('/(tabs)/lists');
          break;
        case 'settings':
          router.push('/(tabs)/settings');
          break;
        default:
          // Sensible fallback — most notifications relate to snapshot data
          router.push('/(tabs)/dashboard');
          break;
      }
    });

    return () => sub.remove();
  }, [router]);
}
