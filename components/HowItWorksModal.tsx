// components/HowItWorksModal.tsx
// "How StayReel Works" explainer shown during onboarding and accessible
// from settings/help. Pure informational — no state side-effects.

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import C from '@/lib/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
}

const STEPS = [
  {
    icon: 'camera-outline' as const,
    color: C.accent,
    title: 'StayReel takes snapshots',
    body: 'A snapshot captures your Instagram follower and following lists at a specific point in time. You can take one manually, or let us do it automatically each day.',
  },
  {
    icon: 'git-compare-outline' as const,
    color: C.teal,
    title: 'We compare snapshots over time',
    body: 'Each new snapshot is compared to the previous one. This is how we detect who followed you, who unfollowed, and other changes.',
  },
  {
    icon: 'bar-chart-outline' as const,
    color: C.green,
    title: 'Results are based on comparisons',
    body: "Everything you see in your dashboard reflects changes between your snapshots — it's not a live Instagram feed. The more snapshots you take, the more complete your picture becomes.",
  },
  {
    icon: 'time-outline' as const,
    color: C.amber,
    title: 'Automatic daily snapshots',
    body: 'If enabled, we take one snapshot per day around midday for recently active users. This counts toward your daily snapshot allowance (3 per day). You can turn this off in Settings.',
  },
  {
    icon: 'notifications-outline' as const,
    color: C.accent,
    title: 'Smart notifications',
    body: "We only send a notification when something meaningful changes — like 3 or more new followers or unfollows. If you posted recently, we'll let you know how your audience responded.",
  },
];

export function HowItWorksModal({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>How StayReel Works</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
            <Ionicons name="close" size={22} color={C.textSecondary} />
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {STEPS.map((step, i) => (
            <View key={i} style={styles.stepCard}>
              <View style={styles.stepHeader}>
                <View style={[styles.iconWrap, { backgroundColor: step.color + '22' }]}>
                  <Ionicons name={step.icon} size={20} color={step.color} />
                </View>
                <Text style={styles.stepNumber}>{i + 1}</Text>
              </View>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepBody}>{step.body}</Text>
            </View>
          ))}

          <View style={styles.footer}>
            <Ionicons name="shield-checkmark-outline" size={18} color={C.teal} />
            <Text style={styles.footerText}>
              Rate limits exist to protect your Instagram account. We scan slowly
              on purpose — up to 3 snapshots per day, 1 per hour.
            </Text>
          </View>

          <TouchableOpacity style={styles.gotItBtn} onPress={onClose} activeOpacity={0.85}>
            <Text style={styles.gotItText}>Got it</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: C.black,
  },
  header: {
    flexDirection:    'row',
    justifyContent:   'space-between',
    alignItems:       'center',
    paddingHorizontal: 20,
    paddingTop:        16,
    paddingBottom:     8,
  },
  title: {
    color:          C.textPrimary,
    fontSize:       22,
    fontWeight:     '800',
    letterSpacing:  -0.3,
  },
  closeBtn: {
    width:           34,
    height:          34,
    borderRadius:    17,
    backgroundColor: C.surface,
    alignItems:      'center',
    justifyContent:  'center',
  },
  scroll: {
    padding:       20,
    paddingBottom:  40,
  },
  stepCard: {
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         16,
    marginBottom:    12,
    borderWidth:     1,
    borderColor:     C.border,
  },
  stepHeader: {
    flexDirection: 'row',
    alignItems:    'center',
    marginBottom:  10,
  },
  iconWrap: {
    width:          36,
    height:         36,
    borderRadius:   18,
    alignItems:     'center',
    justifyContent: 'center',
  },
  stepNumber: {
    color:       C.textMuted,
    fontSize:    12,
    fontWeight:  '700',
    marginLeft:  'auto',
  },
  stepTitle: {
    color:      C.textPrimary,
    fontSize:   15,
    fontWeight: '700',
    marginBottom: 6,
  },
  stepBody: {
    color:      C.textSecondary,
    fontSize:   13,
    lineHeight: 19,
  },
  footer: {
    flexDirection:    'row',
    alignItems:       'flex-start',
    gap:              10,
    backgroundColor:  C.tealDim,
    borderRadius:     12,
    padding:          14,
    marginTop:        4,
    marginBottom:     20,
  },
  footerText: {
    color:      C.teal,
    fontSize:   12,
    flex:       1,
    lineHeight: 18,
  },
  gotItBtn: {
    backgroundColor: C.accent,
    borderRadius:    14,
    paddingVertical:  14,
    alignItems:      'center',
  },
  gotItText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
});
