// components/DashboardCard.tsx
// A single stat card for the dashboard.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

export interface DashboardCardProps {
  title:     string;
  count:     number;
  icon:      keyof typeof Ionicons.glyphMap;
  iconColor: string;
  bgColor:   string;
  onPress?:  () => void;
}

export function DashboardCard({
  title, count, icon, iconColor, bgColor, onPress,
}: DashboardCardProps) {
  return (
    <TouchableOpacity
      style={[styles.card, { borderLeftColor: iconColor }]}
      onPress={onPress}
      activeOpacity={0.75}
      disabled={!onPress}
    >
      <View style={[styles.iconWrap, { backgroundColor: bgColor }]}>
        <Ionicons name={icon} size={22} color={iconColor} />
      </View>

      <View style={styles.body}>
        <Text style={styles.count}>{count.toLocaleString()}</Text>
        <Text style={styles.title}>{title}</Text>
      </View>

      {onPress && (
        <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor:  C.surface,
    borderRadius:     14,
    borderLeftWidth:  3,
    flexDirection:    'row',
    alignItems:       'center',
    padding:          16,
    gap:              14,
    marginBottom:     10,
  },
  iconWrap: {
    width:         44,
    height:        44,
    borderRadius:  12,
    alignItems:    'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  count: {
    color:      C.textPrimary,
    fontSize:   22,
    fontWeight: '700',
    lineHeight: 26,
  },
  title: {
    color:      C.textSecondary,
    fontSize:   13,
    marginTop:  2,
  },
});
