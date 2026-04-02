// app/_layout.tsx
// Root layout: providers + auth state listener + deep-link handler.

import 'react-native-url-polyfill/auto';
import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';

import { supabase, handleAuthDeepLink } from '@/lib/supabase';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/store/authStore';
import { useAdStore } from '@/store/adStore';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { clearSnapshot } from '@/lib/offlineStorage';
import { useNotifications } from '@/hooks/useNotifications';

function AuthGuard() {
  const router     = useRouter();
  // Cast to string[] — Expo Router types segments as a tuple based on
  // the route tree, but at the root layout we need runtime depth-2 access.
  const segments   = useSegments() as string[];
  const { session, initialised, igAccountId } = useAuthStore();

  useEffect(() => {
    if (!initialised) return;

    const inAuth  = segments[0] === '(auth)';
    const inAuthCallback = segments[0] === 'auth'; // magic-link callback screen
    const inTabs  = segments[0] === '(tabs)';
    const inModal = segments[0] === 'our-promise' || segments[0] === 'troubleshooting';

    if (!session) {
      if (!inAuth && !inAuthCallback) router.replace('/(auth)/sign-in');
    } else if (!igAccountId) {
      if (segments[1] !== 'connect-instagram') {
        router.replace('/(auth)/connect-instagram');
      }
    } else {
      if (!inTabs && !inModal) router.replace('/(tabs)/dashboard');
    }
  }, [session, initialised, igAccountId, segments]);

  return null;
}

export default function RootLayout() {
  const { setSession, setInitialised, setIgAccountId } = useAuthStore();
  const { hydrate: hydrateAds } = useAdStore();
  const hydrateSub = useSubscriptionStore((s) => s.hydrate);
  const resetSub   = useSubscriptionStore((s) => s.reset);

  // Register push notifications + handle notification taps
  useNotifications();

  // Bootstrap: load saved session + ad prefs
  useEffect(() => {
    hydrateAds();

    // Safety timeout: ensure setInitialised() fires even if network hangs.
    // This prevents an infinite loading screen from a hung getSession() or
    // ig_accounts query. 15 s is generous but still catches real hangs.
    let bootstrapDone = false;
    const safetyTimer = setTimeout(() => {
      if (!bootstrapDone) {
        console.warn('[Auth] Bootstrap safety timeout — forcing initialised');
        setInitialised();
      }
    }, 15_000);

    // Wrap the whole bootstrap in try/finally so setInitialised() is
    // always called even if the ig_accounts query or getSession() throws.
    const bootstrap = async () => {
      try {
        // ── Step 1: Handle incoming deep link (magic-link callback) ──
        // Process BEFORE reading the stored session so a fresh PKCE code
        // exchange is reflected in the getSession() call that follows.
        // Race with a 10 s timeout so a slow network can't hang bootstrap.
        const initialUrl = await Linking.getInitialURL();
        console.log('[Auth] Bootstrap — initial URL:', initialUrl ?? 'none');

        if (initialUrl) {
          await Promise.race([
            handleAuthDeepLink(initialUrl),
            new Promise<void>((r) => setTimeout(r, 10_000)),
          ]);
        }

        // ── Step 2: Load current session ─────────────────────────────
        const { data: { session: storedSession } } = await supabase.auth.getSession();
        console.log(
          '[Auth] Bootstrap — stored session:',
          storedSession ? `user=${storedSession.user.id}` : 'none',
        );

        // Only refresh when the token is actually expired or within 60 s of
        // expiry. Refreshing unconditionally burns refresh tokens on every app
        // open and creates a race condition during hot-reload (two bootstrap
        // calls both read the same refresh token; the second one fails and
        // triggers a spurious sign-out).
        let session = storedSession;
        if (storedSession) {
          const expiresAt = storedSession.expires_at ?? 0; // unix seconds
          const isExpiring = (expiresAt * 1_000 - Date.now()) < 60_000;
          if (isExpiring) {
            console.log('[Auth] Session expiring soon, refreshing…');
            const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError) {
              // Stale / consumed refresh token — clear locally without a server
              // round-trip to avoid extra noise from the revocation endpoint.
              const isStale =
                /refresh token/i.test(refreshError.message) ||
                /not found/i.test(refreshError.message);
              if (isStale) {
                console.log('[Auth] Refresh token expired, clearing local session');
              } else {
                console.warn('[Auth] Refresh failed:', refreshError.message);
              }
              await supabase.auth.signOut({ scope: 'local' });
              session = null;
            } else {
              session = refreshed.session;
              console.log('[Auth] Session refreshed successfully');
            }
          }
        }

        setSession(session);

        if (session?.user) {
          const { data } = await supabase
            .from('ig_accounts')
            .select('id')
            .eq('user_id', session.user.id)
            .is('deleted_at', null)
            .eq('status', 'active')
            .limit(1)
            .maybeSingle();
          if (data?.id) setIgAccountId(data.id);

          // Hydrate subscription state (RevenueCat + Supabase profile)
          hydrateSub(session.user.id).catch((err: Error) =>
            console.warn('[Auth] Subscription hydrate error:', err.message),
          );
        }
      } finally {
        bootstrapDone = true;
        clearTimeout(safetyTimer);
        console.log('[Auth] Bootstrap complete, initialised = true');
        setInitialised();
      }
    };
    bootstrap();

    // Auth state changes (sign-in / sign-out / token refresh)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      // @ts-ignore — supabase-js ships only .d.mts/.d.cts; tsc resolves fine via
      // bundler exports-field but some tsserver builds can't follow it.
      async (event, session) => {
        console.log('[Auth] onAuthStateChange:', event, session ? 'session' : 'no-session');
        setSession(session);
        if (!session) {
          setIgAccountId(null);
          resetSub();
          clearSnapshot(); // Wipe cached snapshot on sign-out
        } else if (
          event === 'SIGNED_IN' ||
          event === 'TOKEN_REFRESHED' ||
          event === 'INITIAL_SESSION'
        ) {
          // For INITIAL_SESSION, skip the ig_accounts re-query if bootstrap
          // already populated igAccountId — avoids a race where this handler
          // momentarily nulls out igAccountId, causing AuthGuard to flash the
          // connect-instagram screen.
          const currentIgId = useAuthStore.getState().igAccountId;
          if (event === 'INITIAL_SESSION' && currentIgId) {
            console.log('[Auth] INITIAL_SESSION: igAccountId already set, skipping re-query');
          } else {
            // Re-fetch igAccountId so AuthGuard doesn't redirect a freshly
            // signed-in user to /connect-instagram when they already have an
            // account linked.  Timeout after 10s so a hung Supabase query
            // doesn't leave the user stuck on the wrong screen.
            const queryPromise = supabase
              .from('ig_accounts')
              .select('id')
              .eq('user_id', session.user.id)
              .is('deleted_at', null)
              .eq('status', 'active')
              .limit(1)
              .maybeSingle();

            const result = await Promise.race([
              queryPromise,
              new Promise<{ data: null }>((resolve) =>
                setTimeout(() => {
                  console.warn('[Auth] ig_accounts query timed out (10s)');
                  resolve({ data: null });
                }, 10_000),
              ),
            ]);
            setIgAccountId(result.data?.id ?? null);
          }

          // Ensure subscription state is loaded (covers warm magic-link sign-in)
          hydrateSub(session.user.id).catch((err: Error) =>
            console.warn('[Auth] Subscription hydrate error (state change):', err.message),
          );
        }
      },
    );

    // Deep-link handler for warm starts (app already running)
    const handleUrl = async ({ url }: { url: string }) => {
      console.log('[Auth] Deep link received (warm):', url);
      try {
        const ok = await handleAuthDeepLink(url);
        if (!ok) console.warn('[Auth] Warm deep-link produced no session');
      } catch (e: any) {
        console.warn('[Auth] Warm deep-link handler error:', e?.message);
      }
    };
    const sub = Linking.addEventListener('url', handleUrl);
    // NOTE: getInitialURL is handled inside bootstrap above — do NOT
    // call it again here to avoid a duplicate PKCE code exchange race.

    return () => {
      subscription.unsubscribe();
      sub.remove();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <AuthGuard />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="auth" />
          <Stack.Screen name="(auth)" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="our-promise" />
          <Stack.Screen name="troubleshooting" />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
