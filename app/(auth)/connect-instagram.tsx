// app/(auth)/connect-instagram.tsx
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import CookieManager from '@react-native-cookies/cookies';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';
import C from '@/lib/colors';

function isLoginPage(url: string) {
  return (
    !url ||
    url.includes('/accounts/login') ||
    url.includes('/accounts/signup') ||
    url.includes('/challenge') ||
    url.includes('/two_factor')
  );
}

const IG_LOGIN_URL = 'https://www.instagram.com/accounts/login/?next=%2F';

export default function ConnectInstagramScreen() {
  const { setIgAccountId, session } = useAuthStore();
  const hydrateSub = useSubscriptionStore((s) => s.hydrate);
  const router = useRouter();
  const qc = useQueryClient();
  const [submitting, setSubmitting]   = useState(false);
  const [webviewKey, setWebviewKey]   = useState(0);
  const [loggedIn, setLoggedIn]       = useState(false); // feed is visible
  const hasSubmitted = useRef(false);

  // Track whether the user has left the login page
  const onNavigationStateChange = useCallback((nav: any) => {
    if (!nav.loading && nav.url && !isLoginPage(nav.url)) {
      setLoggedIn(true);
    } else if (nav.url && isLoginPage(nav.url)) {
      setLoggedIn(false);
      hasSubmitted.current = false;
    }
  }, []);

  // User taps "Connect this account" — read cookie then submit
  const handleConnect = useCallback(async () => {
    if (hasSubmitted.current || submitting) return;
    try {
      // Small delay — Android WebView persists cookies asynchronously
      await new Promise(resolve => setTimeout(resolve, 600));

      const cookies = await CookieManager.get('https://www.instagram.com', true);
      const sessionId = cookies['sessionid']?.value;

      if (!sessionId) {
        Alert.alert(
          'Cookie not found',
          'Could not read the Instagram session cookie. Try scrolling the feed for a moment then tap Connect again.',
        );
        return;
      }

      hasSubmitted.current = true;
      const csrfToken = cookies['csrftoken']?.value ?? '';
      const sessionCookie = `sessionid=${sessionId}${csrfToken ? `; csrftoken=${csrfToken}` : ''}`;
      await submitCookie(sessionCookie);
    } catch {
      Alert.alert(
        'Dev build required',
        'Reading session cookies requires a native dev build.\n\nRun: npx expo run:android',
      );
    }
  }, [submitting]);

  const submitCookie = async (sessionCookie: string) => {
    setSubmitting(true);
    try {
      let token = session?.access_token ?? null;
      if (!token) {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token ?? null;
      }
      if (!token) {
        const { data } = await supabase.auth.refreshSession();
        token = data.session?.access_token ?? null;
      }
      if (!token) throw new Error('Not signed in. Please go back and sign in first.');

      const res = await fetchWithTimeout(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/connect-instagram`,
        {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization:  `Bearer ${token}`,
            apikey:         process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
          },
          body: JSON.stringify({ session_cookie: sessionCookie }),
          timeoutMs: 30_000, // 30s — this call can be slow
        },
      );

      const json = await res.json();
      if (!res.ok) throw new Error(json?.message ?? `HTTP ${res.status}`);

      setIgAccountId(json.ig_account_id);

      // Ensure subscription state is hydrated before navigating —
      // prevents a flash of "free" state on the dashboard.
      if (session?.user?.id) {
        hydrateSub(session.user.id).catch(() => {});
      }

      // Invalidate any cached queries so dashboard fetches fresh data
      qc.invalidateQueries();

      router.replace('/(tabs)/dashboard');
    } catch (err: any) {
      hasSubmitted.current = false;
      Alert.alert('Connection failed', err.message ?? 'Unknown error', [
        { text: 'Retry', onPress: () => { setWebviewKey(k => k + 1); setLoggedIn(false); } },
        { text: 'OK' },
      ]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="logo-instagram" size={22} color={C.accent} />
        <Text style={styles.headerTitle}>Connect Instagram</Text>
      </View>

      <Text style={styles.subtitle}>
        {loggedIn
          ? 'Tap the button below to connect this Instagram account to StayReel.'
          : 'Log in with your Instagram credentials below. Your password goes directly to Instagram — StayReel only receives the session token.'}
      </Text>

      {/* WebView */}
      <View style={styles.webviewWrap}>
        <WebView
          key={webviewKey}
          source={{ uri: IG_LOGIN_URL }}
          onNavigationStateChange={onNavigationStateChange}
          javaScriptEnabled
          domStorageEnabled
          thirdPartyCookiesEnabled
          sharedCookiesEnabled
          userAgent={
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) ' +
            'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 ' +
            'Mobile/15E148 Safari/604.1'
          }
          style={styles.webview}
        />

        {/* Submitting overlay */}
        {submitting && (
          <View style={styles.overlay}>
            <ActivityIndicator size="large" color={C.accent} />
            <Text style={styles.overlayText}>Connecting your account…</Text>
          </View>
        )}
      </View>

      {/* Connect button — shown once the Instagram feed is visible */}
      {loggedIn && !submitting && (
        <TouchableOpacity style={styles.connectBtn} onPress={handleConnect} activeOpacity={0.85}>
          <Ionicons name="checkmark-circle" size={20} color="#fff" />
          <Text style={styles.connectBtnText}>Connect this account</Text>
        </TouchableOpacity>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:           { flex: 1, backgroundColor: C.black },
  header:         { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  headerTitle:    { color: C.textPrimary, fontSize: 20, fontWeight: '700' },
  subtitle:       { color: C.textSecondary, fontSize: 13, lineHeight: 19, paddingHorizontal: 20, marginBottom: 8 },
  webviewWrap:    { flex: 1, position: 'relative' },
  webview:        { flex: 1 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.78)',
    zIndex: 10,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 14,
  },
  overlayText:    { color: C.textSecondary, fontSize: 14 },
  connectBtn: {
    flexDirection:   'row',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             8,
    backgroundColor: C.accent,
    margin:          16,
    paddingVertical: 14,
    borderRadius:    12,
  },
  connectBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
