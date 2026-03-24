// app/index.tsx
// Root route — renders a splash/loading screen while auth hydrates.
//
// ⚠️  DO NOT put a <Redirect> here. AuthGuard in _layout.tsx handles
//     all navigation once `initialised` is true. A premature redirect
//     causes a flash-to-login on cold open even when a valid session
//     exists in AsyncStorage.

import React from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import C from '@/lib/colors';

export default function Index() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color={C.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
