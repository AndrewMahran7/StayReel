// app/_layout.tsx
// Root layout: providers + auth state listener + deep-link handler.

import 'react-native-url-polyfill/auto';
import React, { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';

import { supabase, handleAuthDeepLink } from '@/lib/supabase';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/store/authStore';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { clearSnapshot } from '@/lib/offlineStorage';
import { clearActiveJob } from '@/lib/snapshotJobStore';
import { useNotifications } from '@/hooks/useNotifications';

function AuthGuard() {
  const router     = useRouter();
  // Cast to string[] — Expo Router types segments as a tuple based on
  // the route tree, but at the root layout we need runtime depth-2 access.
  const segments   = useSegments() as string[];
  const {
    session,
    initialised,
    igAccountId,
    pendingNotificationRoute,
    setPendingNotificationRoute,
  } = useAuthStore();

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
      // User is fully signed in with an IG account — route to tabs.
      if (!inTabs && !inModal) {
        // If a notification queued a route during cold start, consume it.
        if (pendingNotificationRoute) {
          const route = pendingNotificationRoute;
          setPendingNotificationRoute(null);
          console.log('[AuthGuard] Consuming pending notification route:', route);
          // Invalidate dashboard so the data is fresh on arrival
          queryClient.invalidateQueries({ queryKey: ['dashboard'] });
          router.replace(route as any);
        } else {
          router.replace('/(tabs)/dashboard');
        }
      }
    }
  }, [session, initialised, igAccountId, segments, pendingNotificationRoute]);

  return null;
}

export default function RootLayout() {
  const { setSession, setInitialised, setIgAccountId, setTermsAccepted } = useAuthStore();
  const hydrateSub = useSubscriptionStore((s) => s.hydrate);
  const resetSub   = useSubscriptionStore((s) => s.reset);

  // Register push notifications + handle notification taps
  useNotifications();

  // ── Track last_app_open_at + timezone on open and foreground ──
  const appStateRef = useRef(AppState.currentState);
  useEffect(() => {
    const updatePresence = () => {
      const userId = useAuthStore.getState().session?.user?.id;
      if (!userId) return;
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
      supabase.from('profiles').update({
        last_app_open_at: new Date().toISOString(),
        ...(timezone ? { timezone } : {}),
      }).eq('id', userId).then(() => {});
    };
    // Fire on mount (app open)
    updatePresence();
    // Fire on foreground (background → active)
    const sub = AppState.addEventListener('change', (nextState) => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;
      if (nextState === 'active' && prev !== 'active') updatePresence();
    });
    return () => sub.remove();
  }, []);

  // Bootstrap: load saved session
  useEffect(() => {

    // Safety timeout: last-resort backstop that fires setInitialised() if
    // the entire bootstrap hangs. Each network call below has its own
    // per-operation timeout so this should never fire in practice.
    let bootstrapDone = false;
    const safetyTimer = setTimeout(() => {
      if (!bootstrapDone) {
        console.warn('[Auth] Bootstrap safety timeout — forcing initialised');
        setInitialised();
      }
    }, 5_000);

    /** Race a promise against a timeout. Resolves with the fallback on timeout. */
    function withTimeout<T>(promise: PromiseLike<T>, ms: number, fallback: T, label: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        Promise.resolve(promise),
        new Promise<T>((resolve) => {
          timer = setTimeout(() => {
            console.warn(`[Auth] ${label} timed out (${ms}ms)`);
            resolve(fallback);
          }, ms);
        }),
      ]).finally(() => clearTimeout(timer!));
    }

    // Wrap the whole bootstrap in try/finally so setInitialised() is
    // always called even if the ig_accounts query or getSession() throws.
    const bootstrap = async () => {
      try {
        // ── Step 1: Handle incoming deep link (magic-link callback) ──
        // Process BEFORE reading the stored session so a fresh token
        // verification is reflected in the getSession() call that follows.
        // Race with an 8 s timeout so a slow network can't hang bootstrap.
        const initialUrl = await Linking.getInitialURL();
        console.log('[Auth] Bootstrap — initial URL:', initialUrl ?? 'none');

        if (initialUrl) {
          await withTimeout(
            handleAuthDeepLink(initialUrl).then(() => {}),
            8_000,
            undefined,
            'Deep link exchange',
          );
        }

        // ── Step 2: Load current session ─────────────────────────────
        // getSession() reads from AsyncStorage — no network, very fast.
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
            // Per-operation timeout: 8s for token refresh (network call)
            const refreshResult = await withTimeout(
              supabase.auth.refreshSession(),
              8_000,
              { data: { session: null, user: null }, error: { message: 'Refresh timed out' } as any },
              'Session refresh',
            );

            if (refreshResult.error) {
              // Stale / consumed refresh token — clear locally without a server
              // round-trip to avoid extra noise from the revocation endpoint.
              const isStale =
                /refresh token/i.test(refreshResult.error.message) ||
                /not found/i.test(refreshResult.error.message) ||
                /timed out/i.test(refreshResult.error.message);
              if (isStale) {
                console.log('[Auth] Refresh token expired or timed out, clearing local session');
              } else {
                console.warn('[Auth] Refresh failed:', refreshResult.error.message);
              }
              await supabase.auth.signOut({ scope: 'local' });
              session = null;
            } else {
              session = refreshResult.data.session;
              console.log('[Auth] Session refreshed successfully');
            }
          }
        }

        setSession(session);

        if (session?.user) {
          // ── Step 3: Fetch IG account + terms acceptance (parallel) ──
          // Both are critical — ig_accounts gates AuthGuard routing,
          // terms_accepted gates the TermsAcceptanceModal on connect-instagram.
          // Running them in parallel keeps total latency the same as before.
          const [igResult, termsResult] = await Promise.all([
            withTimeout(
              supabase
                .from('ig_accounts')
                .select('id')
                .eq('user_id', session.user.id)
                .is('deleted_at', null)
                .eq('status', 'active')
                .limit(1)
                .maybeSingle(),
              5_000,
              { data: null, error: null, count: null, status: 408, statusText: 'Timeout' } as any,
              'ig_accounts query',
            ),
            withTimeout(
              supabase
                .from('profiles')
                .select('terms_accepted_at, terms_version')
                .eq('id', session.user.id)
                .maybeSingle(),
              5_000,
              { data: null, error: null } as any,
              'terms hydration',
            ),
          ]);

          if (igResult.data?.id) setIgAccountId(igResult.data.id);

          if (termsResult.data?.terms_accepted_at) {
            console.log('[Auth] Terms already accepted (version:', termsResult.data.terms_version ?? 'unknown', ')');
            setTermsAccepted(true);
          } else {
            console.log('[Auth] Terms not yet accepted');
          }

          // ── Step 4: Non-critical hydration (fire-and-forget) ──
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
          clearActiveJob(); // Clear persisted snapshot job on sign-out
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
            // account linked.  Timeout after 5s so a hung Supabase query
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
                  console.warn('[Auth] ig_accounts query timed out (5s)');
                  resolve({ data: null });
                }, 5_000),
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
    // call it again here to avoid a duplicate token verification race.

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
