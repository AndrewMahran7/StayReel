// app/auth.tsx
// Catches the deep-link route `stayreel://auth?code=...` that Supabase
// sends as the magic-link callback (PKCE flow).
//
// Expo Router navigates here instead of showing "Unmatched Route".
// The code exchange is handled by handleAuthDeepLink in _layout.tsx, which
// fires via Linking.getInitialURL() / Linking.addEventListener. Once the
// session is established, AuthGuard in _layout.tsx automatically redirects
// to the correct screen.

import React, { useEffect } from 'react';
import { ActivityIndicator, View, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { supabase } from '@/lib/supabase';

export default function AuthCallback() {
  const { code, token_hash } = useLocalSearchParams<{
    code?: string;
    token_hash?: string;
    type?: string;
  }>();

  // Belt-and-suspenders: also exchange here in case the layout handler
  // fires before this screen mounts and the code hasn't been consumed yet.
  useEffect(() => {
    async function exchange() {
      if (code) {
        await supabase.auth.exchangeCodeForSession(code);
      } else if (token_hash) {
        await supabase.auth.verifyOtp({
          token_hash,
          type: 'magiclink',
        });
      }
    }
    exchange();
  }, [code, token_hash]);

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
});
