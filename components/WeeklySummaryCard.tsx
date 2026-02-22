// components/WeeklySummaryCard.tsx
// Shows total follower changes over the past 7 days.
// Only rendered when has_weekly_summary === true (>= 2 complete diffs in 7 days).

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

interface WeeklySummaryProps {
  newFollowers:  number;
  lostFollowers: number;
  netChange:     number;
}

export function WeeklySummaryCard({ newFollowers, lostFollowers, netChange }: WeeklySummaryProps) {
  const isPositive = netChange >= 0;

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="calendar-outline" size={15} color={C.textMuted} />
        <Text style={styles.headerText}>This week</Text>
      </View>

      <View style={styles.stats}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>+{newFollowers.toLocaleString()}</Text>
          <Text style={styles.statLabel}>New</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: C.red }]}>-{lostFollowers.toLocaleString()}</Text>
          <Text style={styles.statLabel}>Lost</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: isPositive ? C.green : C.red }]}>
            {isPositive ? '+' : ''}{netChange.toLocaleString()}
          </Text>
          <Text style={styles.statLabel}>Net</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         14,
    marginBottom:    14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           5,
    marginBottom:  10,
  },
  headerText: {
    color:      C.textMuted,
    fontSize:   12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  stats: {
    flexDirection:  'row',
    justifyContent: 'space-between',
    alignItems:     'center',
  },
  stat: {
    flex:       1,
    alignItems: 'center',
    gap:        2,
  },
  statValue: {
    color:      C.green,
    fontSize:   22,
    fontWeight: '800',
  },
  statLabel: {
    color:    C.textMuted,
    fontSize: 11,
  },
  divider: {
    width:           1,
    height:          28,
    backgroundColor: C.border,
  },
});
