// components/SnapshotStatusCard.tsx
// Persistent snapshot status card for the dashboard showing:
//   - Last snapshot time
//   - Next automatic snapshot estimate
//   - Manual snapshots remaining today
//   - Whether auto daily snapshots are enabled

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';
import { RECONNECT_COPY } from '@/lib/reconnectCopy';

interface Props {
  lastSnapshotAt: string | null;
  snapshotsToday: number;
  dailyCap: number;
  autoSnapshotEnabled: boolean;
  isCapturing: boolean;
  reconnectRequired?: boolean;
}

export function SnapshotStatusCard({
  lastSnapshotAt,
  snapshotsToday,
  dailyCap,
  autoSnapshotEnabled,
  isCapturing,
  reconnectRequired = false,
}: Props) {
  const remainingToday = Math.max(0, dailyCap - snapshotsToday);

  const lastLabel = lastSnapshotAt
    ? new Date(lastSnapshotAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : 'No snapshots yet';

  const nextAutoLabel = reconnectRequired
    ? RECONNECT_COPY.statusCardNextAuto
    : autoSnapshotEnabled
    ? 'Around noon your time'
    : 'Disabled';

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="pulse-outline" size={16} color={reconnectRequired ? C.amber : C.teal} />
        <Text style={styles.headerText}>
          {reconnectRequired ? 'Tracking Paused' : 'Snapshot Status'}
        </Text>
      </View>

      <View style={styles.grid}>
        <StatusItem
          icon="time-outline"
          iconColor={C.textMuted}
          label="Last snapshot"
          value={isCapturing ? 'In progress…' : lastLabel}
        />
        <StatusItem
          icon="calendar-outline"
          iconColor={C.teal}
          label="Next auto snapshot"
          value={nextAutoLabel}
        />
        <StatusItem
          icon="camera-outline"
          iconColor={C.accent}
          label="Remaining today"
          value={`${remainingToday} of ${dailyCap} (auto + manual)`}
        />
        <StatusItem
          icon="refresh-outline"
          iconColor={reconnectRequired ? C.amber : autoSnapshotEnabled ? C.green : C.textMuted}
          label="Auto snapshots"
          value={reconnectRequired ? RECONNECT_COPY.statusCardAutoLabel : autoSnapshotEnabled ? 'Enabled' : 'Disabled'}
        />
      </View>
    </View>
  );
}

function StatusItem({
  icon,
  iconColor,
  label,
  value,
}: {
  icon: any;
  iconColor: string;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.item}>
      <Ionicons name={icon} size={14} color={iconColor} style={styles.itemIcon} />
      <View style={styles.itemText}>
        <Text style={styles.itemLabel}>{label}</Text>
        <Text style={styles.itemValue}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     C.border,
    padding:         14,
    marginBottom:    14,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    marginBottom:  12,
  },
  headerText: {
    color:      C.textSecondary,
    fontSize:   12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  grid: {
    flexDirection: 'row',
    flexWrap:      'wrap',
  },
  item: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    width:         '50%',
    paddingRight:  8,
    marginBottom:  10,
  },
  itemIcon: {
    marginTop:  2,
    marginRight: 6,
  },
  itemText: {
    flex: 1,
  },
  itemLabel: {
    color:    C.textMuted,
    fontSize: 11,
  },
  itemValue: {
    color:      C.textPrimary,
    fontSize:   13,
    fontWeight: '600',
    marginTop:  1,
  },
});
