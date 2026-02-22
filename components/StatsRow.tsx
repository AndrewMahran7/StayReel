// components/StatsRow.tsx
// Three-stat row: Followers | Following | Friends (mutual)

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import C from '@/lib/colors';

interface StatsRowProps {
  followerCount:  number;
  followingCount: number;
  mutualCount:    number;
}

interface StatItemProps {
  label: string;
  value: number;
  accent?: string;
}

function StatItem({ label, value, accent }: StatItemProps) {
  return (
    <View style={styles.item}>
      <Text style={[styles.value, accent ? { color: accent } : undefined]}>
        {value.toLocaleString()}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

export function StatsRow({ followerCount, followingCount, mutualCount }: StatsRowProps) {
  return (
    <View style={styles.row}>
      <StatItem label="Followers"  value={followerCount}  accent={C.textPrimary} />
      <View style={styles.divider} />
      <StatItem label="Following"  value={followingCount} />
      <View style={styles.divider} />
      <StatItem label="Friends"    value={mutualCount}    accent={C.green} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection:  'row',
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         16,
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   14,
  },
  item: {
    flex:       1,
    alignItems: 'center',
    gap:        2,
  },
  value: {
    color:      C.textPrimary,
    fontSize:   20,
    fontWeight: '700',
  },
  label: {
    color:    C.textMuted,
    fontSize: 11,
    marginTop: 2,
  },
  divider: {
    width:           1,
    height:          32,
    backgroundColor: C.border,
  },
});
