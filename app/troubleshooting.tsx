// app/troubleshooting.tsx
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import C from '@/lib/colors';

const ISSUES = [
  {
    icon:  'log-in-outline' as const,
    color: C.amber,
    title: 'Session expired / Invalid session',
    cause: 'Your Instagram login inside StayReel expired. This is normal and happens every few weeks, or if you logged out of Instagram on your phone.',
    steps: [
      'Go to Settings → Disconnect Instagram.',
      'Open Instagram on your phone and log in normally.',
      'Come back to StayReel → Settings → Reconnect Instagram.',
      'Log in all the way to your home feed, then tap Connect.',
    ],
  },
  {
    icon:  'shield-outline' as const,
    color: '#f5a623',
    title: 'Instagram needs verification / Challenge required',
    cause: 'Instagram flagged unusual activity and put a security challenge on your account. This can happen when an app accesses your account from a server.',
    steps: [
      'Open the Instagram app directly on your phone.',
      'Look for a security alert — tap it and complete the verification (email code, SMS, or "Was this you?" prompt).',
      'Once you pass it, wait about 15 minutes.',
      'Go to StayReel → Settings → Reconnect Instagram.',
    ],
  },
  {
    icon:  'time-outline' as const,
    color: C.teal,
    title: 'Rate limited / Too many requests',
    cause: 'Instagram temporarily slowed down access to your account. StayReel already limits you to 3 snapshots per day to prevent this, but it can still happen.',
    steps: [
      'Wait 1–6 hours before trying again.',
      'Do not keep retrying — repeated attempts make the throttle last longer.',
      'This resolves on its own. No action needed on your account.',
    ],
  },
  {
    icon:  'person-circle-outline' as const,
    color: C.amber,
    title: 'StayReel session expired (not Instagram)',
    cause: 'Your StayReel login — separate from Instagram — expired. This is unrelated to your Instagram account.',
    steps: [
      'Tap Sign Out in Settings.',
      'Sign back in with your email.',
      'You will not lose any data. Everything is saved.',
    ],
  },
  {
    icon:  'warning-outline' as const,
    color: C.red,
    title: 'Unexpected error / Something went wrong',
    cause: 'An error we didn\'t anticipate. The team is automatically notified when this happens.',
    steps: [
      'Wait a few minutes and try again.',
      'If it keeps happening, email us — see below.',
    ],
  },
];

export default function TroubleshootingScreen() {
  const router = useRouter();
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={22} color={C.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Troubleshooting</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.subtitle}>
          Common errors and how to fix them. Tap any issue to expand.
        </Text>

        {ISSUES.map((issue, i) => {
          const open = expanded === i;
          return (
            <TouchableOpacity
              key={i}
              style={[styles.card, open && { borderColor: issue.color + '55' }]}
              onPress={() => setExpanded(open ? null : i)}
              activeOpacity={0.8}
            >
              {/* Row */}
              <View style={styles.cardRow}>
                <View style={[styles.iconWrap, { backgroundColor: issue.color + '22' }]}>
                  <Ionicons name={issue.icon} size={18} color={issue.color} />
                </View>
                <Text style={styles.cardTitle}>{issue.title}</Text>
                <Ionicons
                  name={open ? 'chevron-up' : 'chevron-down'}
                  size={16}
                  color={C.textMuted}
                />
              </View>

              {/* Expanded */}
              {open && (
                <View style={styles.cardBody}>
                  <Text style={styles.causeLabel}>Why it happens</Text>
                  <Text style={styles.causeText}>{issue.cause}</Text>

                  <Text style={styles.stepsLabel}>How to fix it</Text>
                  {issue.steps.map((step, j) => (
                    <View key={j} style={styles.stepRow}>
                      <View style={[styles.stepBadge, { backgroundColor: issue.color + '22' }]}>
                        <Text style={[styles.stepNum, { color: issue.color }]}>{j + 1}</Text>
                      </View>
                      <Text style={styles.stepText}>{step}</Text>
                    </View>
                  ))}
                </View>
              )}
            </TouchableOpacity>
          );
        })}

        {/* Help card */}
        <View style={styles.helpCard}>
          <Ionicons name="chatbubble-ellipses-outline" size={22} color={C.teal} style={styles.helpIcon} />
          <Text style={styles.helpHeading}>Still stuck? Don't stress.</Text>
          <Text style={styles.helpBody}>
            You don't have to figure this out alone. If something isn't working and you don't want to mess with your account, just send an email — I'll walk you through it personally or resolve it on my end.
          </Text>
          <TouchableOpacity
            style={styles.emailBtn}
            activeOpacity={0.75}
            onPress={() => Linking.openURL('mailto:mahranandrew@gmail.com?subject=StayReel Help')}
          >
            <Ionicons name="mail-outline" size={15} color={C.teal} style={{ marginRight: 6 }} />
            <Text style={styles.emailBtnText}>mahranandrew@gmail.com</Text>
          </TouchableOpacity>

          <View style={styles.divider} />

          <Text style={styles.helpBody}>
            And if you just want to walk away — that's completely fine too. Delete the app, no hard feelings. Your data is removed when you delete your account in Settings.
          </Text>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe:  { flex: 1, backgroundColor: C.black },

  header: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'space-between',
    paddingHorizontal: 16,
    paddingTop:        8,
    paddingBottom:     12,
  },
  backBtn: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  title: {
    color: C.textPrimary, fontSize: 18, fontWeight: '700',
  },

  scroll: { padding: 16, paddingBottom: 48 },

  subtitle: {
    color:        C.textSecondary,
    fontSize:     14,
    lineHeight:   20,
    marginBottom: 16,
    textAlign:    'center',
  },

  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    borderWidth:     1,
    borderColor:     'transparent',
    marginBottom:    8,
    overflow:        'hidden',
  },
  cardRow: {
    flexDirection: 'row',
    alignItems:    'center',
    padding:       14,
    gap:           12,
  },
  iconWrap: {
    width: 36, height: 36,
    borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  cardTitle: {
    flex:       1,
    color:      C.textPrimary,
    fontSize:   14,
    fontWeight: '600',
    lineHeight: 20,
  },

  cardBody: {
    paddingHorizontal: 14,
    paddingBottom:     16,
  },
  causeLabel: {
    color:        C.textMuted,
    fontSize:     11,
    fontWeight:   '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom:  6,
  },
  causeText: {
    color:        C.textSecondary,
    fontSize:     13,
    lineHeight:   19,
    marginBottom: 14,
  },
  stepsLabel: {
    color:        C.textMuted,
    fontSize:     11,
    fontWeight:   '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom:  8,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    gap:           10,
    marginBottom:  8,
  },
  stepBadge: {
    width: 22, height: 22,
    borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    marginTop: 1,
  },
  stepNum:  { fontSize: 12, fontWeight: '700' },
  stepText: { flex: 1, color: C.textSecondary, fontSize: 13, lineHeight: 19 },

  helpCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         20,
    alignItems:      'center',
    marginTop:       8,
  },
  helpIcon:    { marginBottom: 12 },
  helpHeading: {
    color:        C.textPrimary,
    fontSize:     16,
    fontWeight:   '700',
    marginBottom: 8,
    textAlign:    'center',
  },
  helpBody: {
    color:        C.textSecondary,
    fontSize:     13,
    lineHeight:   19,
    textAlign:    'center',
    marginBottom: 16,
  },
  emailBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    backgroundColor:   C.teal + '22',
    borderRadius:      10,
    paddingVertical:   10,
    paddingHorizontal: 18,
    marginBottom:      4,
  },
  emailBtnText: { color: C.teal, fontSize: 14, fontWeight: '600' },
  divider: {
    width:           '80%',
    height:          1,
    backgroundColor: C.surfaceAlt,
    marginVertical:  16,
  },
});
