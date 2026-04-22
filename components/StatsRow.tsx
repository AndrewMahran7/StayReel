// components/StatsRow.tsx
// Three-stat row: Followers | Following | Friends (mutual)
// Each stat is tappable and navigates to the corresponding list.

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import C from '@/lib/colors';

export type StatsRowListKey = 'followers' | 'following' | 'friends';

interface StatsRowProps {
  followerCount:  number;
  followingCount: number;
  mutualCount:    number;
  /** Optional tap handler — if provided each stat becomes a button. */
  onStatPress?: (key: StatsRowListKey) => void;
}

interface StatItemProps {
  label:   string;
  value:   number;
  accent?: string;
  onPress?: () => void;
  testID?: string;
}

function StatItem({ label, value, accent, onPress, testID }: StatItemProps) {
  const content = (
    <>
      <Text style={[styles.value, accent ? { color: accent } : undefined]}>
        {value.toLocaleString()}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </>
  );
  if (onPress) {
    return (
      <TouchableOpacity
        style={styles.item}
        onPress={onPress}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${value.toLocaleString()} ${label}, tap to view`}
        testID={testID}
      >
        {content}
      </TouchableOpacity>
    );
  }
  return <View style={styles.item}>{content}</View>;
}

export function StatsRow({ followerCount, followingCount, mutualCount, onStatPress }: StatsRowProps) {
  return (
    <View style={styles.row}>
      <StatItem
        label="Followers"
        value={followerCount}
        accent={C.textPrimary}
        onPress={onStatPress ? () => onStatPress('followers') : undefined}
        testID="stats-followers"
      />
      <View style={styles.divider} />
      <StatItem
        label="Following"
        value={followingCount}
        onPress={onStatPress ? () => onStatPress('following') : undefined}
        testID="stats-following"
      />
      <View style={styles.divider} />
      <StatItem
        label="Friends"
        value={mutualCount}
        accent={C.green}
        onPress={onStatPress ? () => onStatPress('friends') : undefined}
        testID="stats-friends"
      />
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
    paddingVertical: 4,
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
