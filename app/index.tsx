// app/index.tsx
// Root route — renders a splash/loading screen while auth hydrates.
//
// ⚠️  DO NOT put a <Redirect> here. AuthGuard in _layout.tsx handles
//     all navigation once `initialised` is true. A premature redirect
//     causes a flash-to-login on cold open even when a valid session
//     exists in AsyncStorage.

import React, { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import C from '@/lib/colors';

export default function Index() {
  const [showSlow, setShowSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowSlow(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>StayReel</Text>
      <ActivityIndicator size="large" color={C.accent} style={styles.spinner} />
      <Text style={styles.loading}>Loading your account…</Text>
      {showSlow && (
        <Text style={styles.slow}>Taking longer than usual — hang tight</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.black,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  brand: {
    color: C.accent,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 24,
  },
  spinner: {
    marginBottom: 16,
  },
  loading: {
    color: C.textSecondary,
    fontSize: 14,
  },
  slow: {
    color: C.textMuted,
    fontSize: 13,
    marginTop: 12,
    textAlign: 'center',
  },
});
