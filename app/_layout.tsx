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

function AuthGuard() {
  const router     = useRouter();
  // Cast to string[] — Expo Router types segments as a tuple based on
  // the route tree, but at the root layout we need runtime depth-2 access.
  const segments   = useSegments() as string[];
  const { session, initialised, igAccountId } = useAuthStore();

  useEffect(() => {
    if (!initialised) return;

    const inAuth  = segments[0] === '(auth)';
    const inTabs  = segments[0] === '(tabs)';

    if (!session) {
      if (!inAuth) router.replace('/(auth)/sign-in');
    } else if (!igAccountId) {
      if (segments[1] !== 'connect-instagram') {
        router.replace('/(auth)/connect-instagram');
      }
    } else {
      if (!inTabs) router.replace('/(tabs)/dashboard');
    }
  }, [session, initialised, igAccountId, segments]);

  return null;
}

export default function RootLayout() {
  const { setSession, setInitialised, setIgAccountId } = useAuthStore();
  const { hydrate: hydrateAds } = useAdStore();

  // Bootstrap: load saved session + ad prefs
  useEffect(() => {
    hydrateAds();

    // Wrap the whole bootstrap in try/finally so setInitialised() is
    // always called even if the ig_accounts query or getSession() throws.
    const bootstrap = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
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
        }
      } finally {
        setInitialised();
      }
    };
    bootstrap();

    // Auth state changes (sign-in / sign-out)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      // @ts-ignore — supabase-js ships only .d.mts/.d.cts; tsc resolves fine via
      // bundler exports-field but some tsserver builds can't follow it.
      async (_event, session) => {
        setSession(session);
        if (!session) setIgAccountId(null);
      },
    );

    // Deep-link handler (magic link callback)
    const handleUrl = ({ url }: { url: string }) => handleAuthDeepLink(url);
    const sub = Linking.addEventListener('url', handleUrl);
    Linking.getInitialURL().then((url: string | null) => handleAuthDeepLink(url));

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
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}
