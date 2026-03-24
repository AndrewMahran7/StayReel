// components/LockedUserRow.tsx
// Teaser row for locked list items (free-tier gating).
// Matches the layout / dimensions of UserListItem so the list
// scrolls seamlessly from real rows into locked ones.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

interface Props {
  /** Visual fade — rows further from the free boundary are more transparent. */
  opacity?: number;
}

export function LockedUserRow({ opacity = 1 }: Props) {
  return (
    <View style={[styles.row, { opacity }]} pointerEvents="none">
      {/* Placeholder avatar */}
      <View style={styles.avatar} />

      {/* Placeholder username bar */}
      <View style={styles.info}>
        <View style={styles.namePlaceholder} />
      </View>

      {/* Lock icon */}
      <Ionicons name="lock-closed" size={14} color={C.textMuted} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingVertical:   12,
    paddingHorizontal: 16,
    gap:               12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  avatar: {
    width:           42,
    height:          42,
    borderRadius:    21,
    backgroundColor: C.surfaceAlt,
  },
  info: {
    flex: 1,
  },
  namePlaceholder: {
    width:           '60%',
    height:          12,
    borderRadius:    6,
    backgroundColor: C.surfaceAlt,
  },
});
