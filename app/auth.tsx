// app/auth.tsx
// Catches the deep-link route `stayreel://auth?code=...` that Supabase
// sends as the magic-link callback (PKCE flow).
//
// The actual PKCE code exchange is handled by the root layout:
//   • Cold start  → bootstrap() calls Linking.getInitialURL() then handleAuthDeepLink()
//   • Warm start  → Linking.addEventListener('url') fires handleAuthDeepLink()
//
// This screen is just a visual placeholder (spinner) while the exchange
// resolves and AuthGuard redirects.  A 15-second timeout provides an
// escape hatch if something goes wrong.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/store/authStore';

export default function AuthCallback() {
  const router = useRouter();
  const { session } = useAuthStore();
  const [timedOut, setTimedOut] = useState(false);

  // Safety-net: if no session after 15 s, let the user retry.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!session) {
        console.warn('[Auth] auth.tsx timed out waiting for session');
        setTimedOut(true);
      }
    }, 15_000);
    return () => clearTimeout(timer);
  }, [session]);

  if (timedOut) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorText}>Sign-in timed out.{"\n"}Please try again.</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => router.replace('/(auth)/sign-in')}
        >
          <Text style={styles.retryText}>Back to Sign In</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <ActivityIndicator color="#fff" size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 16,
    textAlign: 'center',
    marginHorizontal: 32,
    marginBottom: 24,
    lineHeight: 24,
  },
  retryButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    backgroundColor: '#222',
  },
  retryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
