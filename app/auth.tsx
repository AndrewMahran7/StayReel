// app/auth.tsx
// Catches the deep-link route `stayreel://auth?code=...` that Supabase
// sends as the magic-link callback (PKCE flow).
//
// Primary exchange is handled by the root layout (Linking.getInitialURL
// on cold start, addEventListener on warm start). This screen acts as a
// **fallback**: if the root layout handler misses the URL or loses a race,
// auth.tsx reads the `code` from expo-router search params and retries the
// exchange itself. It also surfaces errors and provides retry / back-to-
// sign-in options so the user is never stranded on a blank spinner.

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { useAuthStore } from '@/store/authStore';
import { exchangeAuthCode, handleAuthDeepLink } from '@/lib/supabase';
import C from '@/lib/colors';

/** Seconds before the fallback exchange fires (gives root layout first shot). */
const FALLBACK_DELAY_MS = 2_000;
/** Seconds before we show the error state if nothing has worked. */
const SAFETY_TIMEOUT_MS = 10_000;

export default function AuthCallback() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    code?: string;
    error?: string;
    error_description?: string;
    token_hash?: string;
    type?: string;
  }>();
  const { session } = useAuthStore();

  const [error, setError]         = useState<string | null>(null);
  const [exchanging, setExchanging] = useState(false);
  const attemptedRef = useRef(false);

  // ── 1. Surface errors forwarded by Supabase in the redirect URL ────
  useEffect(() => {
    if (params.error) {
      const desc = params.error_description ?? params.error;
      console.warn('[Auth] auth.tsx received error param:', desc);
      setError(desc ?? 'Authentication failed. Please request a new link.');
    }
  }, [params.error, params.error_description]);

  // ── 2. Fallback code exchange ──────────────────────────────────────
  //    Waits FALLBACK_DELAY_MS so the root layout handler can try first,
  //    then attempts the exchange itself if no session appeared.
  useEffect(() => {
    if (session || attemptedRef.current || error) return;
    if (!params.code && !params.token_hash) return;

    const timer = setTimeout(async () => {
      // Re-check: root layout may have succeeded while we waited.
      if (useAuthStore.getState().session) return;

      attemptedRef.current = true;
      setExchanging(true);

      try {
        if (params.code) {
          console.log('[Auth] auth.tsx fallback — exchanging code');
          const result = await exchangeAuthCode(params.code);
          if (!result.success && result.error !== 'Code already processed') {
            setError(result.error ?? 'Code exchange failed.');
          }
        } else if (params.token_hash && params.type) {
          // token_hash fallback — shouldn't normally reach here, but
          // covers edge cases where the redirect contains a hash-verify.
          console.log('[Auth] auth.tsx fallback — verifyOtp via token_hash');
          const url = Linking.createURL('auth', {
            queryParams: {
              token_hash: params.token_hash,
              type: params.type,
            },
          });
          const ok = await handleAuthDeepLink(url);
          if (!ok) setError('Verification failed. Please request a new link.');
        }
      } catch (e: any) {
        console.warn('[Auth] auth.tsx fallback error:', e?.message);
        setError(e?.message ?? 'Something went wrong. Please try again.');
      } finally {
        setExchanging(false);
      }
    }, FALLBACK_DELAY_MS);

    return () => clearTimeout(timer);
  }, [params.code, params.token_hash, params.type, session, error]);

  // ── 3. Safety timeout — catch-all if everything else failed ────────
  useEffect(() => {
    if (session || error) return;
    const timer = setTimeout(() => {
      if (!useAuthStore.getState().session && !error) {
        console.warn('[Auth] auth.tsx safety timeout reached');
        setError('Sign-in is taking too long. Please try again.');
      }
    }, SAFETY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [session, error]);

  // ── Retry handler ──────────────────────────────────────────────────
  const handleRetry = async () => {
    setError(null);
    setExchanging(true);
    attemptedRef.current = false;

    try {
      if (params.code) {
        const result = await exchangeAuthCode(params.code, true /* force */);
        if (!result.success) {
          setError(result.error ?? 'Code exchange failed. The link may have expired.');
        }
      } else {
        // No code in route params — try the raw URL as a last resort.
        const url = await Linking.getInitialURL();
        if (url) {
          const ok = await handleAuthDeepLink(url);
          if (!ok) setError('Could not sign in from this link. Please request a new one.');
        } else {
          setError('No sign-in code available. Please request a new magic link.');
        }
      }
    } catch (e: any) {
      setError(e?.message ?? 'Retry failed.');
    } finally {
      setExchanging(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  if (error) {
    return (
      <View style={styles.container}>
        <Ionicons name="alert-circle-outline" size={48} color={C.red} />
        <Text style={styles.errorText}>{error}</Text>

        <TouchableOpacity
          style={styles.retryButton}
          onPress={handleRetry}
          disabled={exchanging}
        >
          {exchanging ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.retryText}>Try Again</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.replace('/(auth)/sign-in')}
        >
          <Text style={styles.backText}>Request a new link</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator color="#fff" size="large" />
      <Text style={styles.loadingText}>Signing you in…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.black,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  loadingText: {
    color: C.textSecondary,
    fontSize: 15,
    marginTop: 16,
  },
  errorText: {
    color: C.textPrimary,
    fontSize: 16,
    textAlign: 'center',
    marginTop: 16,
    marginBottom: 28,
    lineHeight: 24,
  },
  retryButton: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
    backgroundColor: C.accent,
    minWidth: 160,
    alignItems: 'center',
  },
  retryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  backButton: {
    marginTop: 16,
    paddingVertical: 12,
  },
  backText: {
    color: C.textMuted,
    fontSize: 14,
    textDecorationLine: 'underline',
  },
});
