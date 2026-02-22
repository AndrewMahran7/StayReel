// components/StreakBadge.tsx
// Shows the current growth streak. Only render when streak > 0.

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import C from '@/lib/colors';

interface StreakBadgeProps {
  currentStreak: number;
  longestStreak: number;
}

export function StreakBadge({ currentStreak, longestStreak }: StreakBadgeProps) {
  if (currentStreak < 1) return null;

  return (
    <View style={styles.badge}>
      <Text style={styles.fire}>🔥</Text>
      <View style={styles.textGroup}>
        <Text style={styles.streakText}>
          {currentStreak}-day growth streak!
        </Text>
        {longestStreak > currentStreak && (
          <Text style={styles.bestText}>Best: {longestStreak} days</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.amberDim,
    borderRadius:    10,
    paddingHorizontal: 14,
    paddingVertical:   10,
    gap:             10,
    marginBottom:    14,
  },
  fire: {
    fontSize: 22,
  },
  textGroup: {
    gap: 1,
  },
  streakText: {
    color:      C.amber,
    fontSize:   14,
    fontWeight: '700',
  },
  bestText: {
    color:    C.textMuted,
    fontSize: 12,
  },
});
