// hooks/useNotifications.ts
// Boot-time hook that registers for push notifications and handles
// notification taps (deep-links to the appropriate screen).
//
// Call once in the root layout — the hook is a no-op until the user
// is fully authenticated with a connected IG account.
//
// Cold-start resilience: if a notification tap arrives before auth is
// initialised, the target route is queued in authStore and consumed by
// AuthGuard once the user is fully signed in.

import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/authStore';
import { queryClient } from '@/lib/queryClient';
import { registerForPushNotificationsIfGranted } from '@/lib/notifications';

/** Map a notification payload `screen` field to a valid tab route. */
function resolveRoute(screen: string | undefined): string {
  switch (screen) {
    case 'dashboard': return '/(tabs)/dashboard';
    case 'lists':     return '/(tabs)/lists';
    case 'settings':  return '/(tabs)/settings';
    default:          return '/(tabs)/dashboard';
  }
}

export function useNotifications(): void {
  const router = useRouter();
  const qc     = queryClient;
  const { session, igAccountId, initialised, setPendingNotificationRoute } = useAuthStore();
  const didRegister = useRef(false);

  // ── Silently re-register token on boot (returning users only) ──
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

      const route = resolveRoute(data?.screen as string | undefined);

      // If the app is still bootstrapping (cold start), defer navigation
      // until AuthGuard is ready — otherwise router.push can silently fail
      // or push to the wrong navigator stack before the layout mounts.
      const state = useAuthStore.getState();
      if (!state.initialised || !state.session || !state.igAccountId) {
        console.log('[useNotifications] Auth not ready — queuing route:', route);
        setPendingNotificationRoute(route);
        return;
      }

      // Auth is ready — navigate immediately and refresh dashboard data
      // so the user sees the latest snapshot results.
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['snapshot-history'] });
      router.push(route as any);
    });

    return () => sub.remove();
  }, [router, setPendingNotificationRoute]);

  // ── Cold-start notification: also check getLastNotificationResponseAsync ──
  // If the app was killed and the user tapped a notification, the listener
  // above won't fire. This effect catches that case on first mount.
  useEffect(() => {
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as
        Record<string, unknown> | undefined;
      const route = resolveRoute(data?.screen as string | undefined);
      console.log('[useNotifications] Cold-start notification detected, queuing route:', route);

      const state = useAuthStore.getState();
      if (!state.initialised || !state.session || !state.igAccountId) {
        setPendingNotificationRoute(route);
      } else {
        qc.invalidateQueries({ queryKey: ['dashboard'] });
        router.push(route as any);
      }
    });
  }, []);
}
