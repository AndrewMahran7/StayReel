// app/our-promise.tsx
import React from 'react';
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

const PROMISES = [
  {
    icon: 'heart-outline' as const,
    color: C.teal,
    title: 'You are not the product.',
    body: "Your experience comes first — always. That's why there are no banner ads cluttering the screen. Rate limiting exists to protect your Instagram account, not to push you toward a paywall. And when you have to wait for a refresh? There's a game instead of an ad, because your time deserves more respect than that.",
  },
  {
    icon: 'shield-checkmark-outline' as const,
    color: C.accent,
    title: 'Your data stays yours.',
    body: "Your Instagram session and follower data are stored securely and never sold, shared, or used to target you. StayReel exists to give you visibility into your own account — nothing more.",
  },
  {
    icon: 'person-outline' as const,
    color: C.amber,
    title: 'Indie-built, no investor pressure.',
    body: "StayReel is built and maintained by one developer. There's no board of directors demanding growth at any cost, no dark patterns, and no algorithm quietly steering your decisions.",
  },
  {
    icon: 'cash-outline' as const,
    color: C.green,
    title: 'If pricing ever comes, it will be fair.',
    body: "Some apps charge $30–$50/month for the same basic features, dress it up with fake screenshots, and deliver a broken product. If StayReel ever moves to paid tiers, it will be to cover real costs — servers, development, and keeping the lights on — not to extract money from your emotions.",
  },
];

export default function OurPromiseScreen() {
  const router = useRouter();

  return (
    <SafeAreaView style={styles.safe}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} activeOpacity={0.7}>
          <Ionicons name="chevron-back" size={22} color={C.textPrimary} />
        </TouchableOpacity>
        <Text style={styles.title}>Our Promise</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.subtitle}>
          What we stand for — and what we'll never do.
        </Text>

        {PROMISES.map((p, i) => (
          <View key={i} style={styles.card}>
            <View style={[styles.iconWrap, { backgroundColor: p.color + '22' }]}>
              <Ionicons name={p.icon} size={22} color={p.color} />
            </View>
            <Text style={styles.cardTitle}>{p.title}</Text>
            <Text style={styles.cardBody}>{p.body}</Text>
          </View>
        ))}

        <Text style={styles.footer}>
          StayReel is a one-person project built out of frustration with apps that
          treat users as revenue targets. Thank you for trusting it.
        </Text>

        {/* Contact */}
        <View style={styles.contactCard}>
          <Ionicons name="chatbubble-ellipses-outline" size={22} color={C.teal} style={styles.contactIcon} />
          <Text style={styles.contactHeading}>Have a bug or feature idea?</Text>
          <Text style={styles.contactBody}>
            I read every message. Reach out directly and I'll get back to you.
          </Text>
          <TouchableOpacity
            style={styles.contactBtn}
            activeOpacity={0.75}
            onPress={() => Linking.openURL('mailto:mahranandrew@gmail.com?subject=StayReel Feedback')}
          >
            <Text style={styles.contactBtnText}>mahranandrew@gmail.com</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.black },

  header: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop:      8,
    paddingBottom:   12,
  },
  backBtn: {
    width:          36,
    height:         36,
    alignItems:     'center',
    justifyContent: 'center',
  },
  title: {
    color:      C.textPrimary,
    fontSize:   18,
    fontWeight: '700',
  },

  scroll: {
    padding:       16,
    paddingBottom: 48,
  },
  subtitle: {
    color:        C.textSecondary,
    fontSize:     14,
    lineHeight:   20,
    marginBottom: 20,
    textAlign:    'center',
  },

  card: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         20,
    marginBottom:    12,
  },
  iconWrap: {
    width:          44,
    height:         44,
    borderRadius:   12,
    alignItems:     'center',
    justifyContent: 'center',
    marginBottom:   14,
  },
  cardTitle: {
    color:        C.textPrimary,
    fontSize:     16,
    fontWeight:   '700',
    marginBottom: 8,
  },
  cardBody: {
    color:      C.textSecondary,
    fontSize:   14,
    lineHeight: 21,
  },

  footer: {
    color:      C.textMuted,
    fontSize:   13,
    lineHeight: 19,
    textAlign:  'center',
    marginTop:  8,
    marginBottom: 24,
    paddingHorizontal: 8,
  },

  contactCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         20,
    alignItems:      'center',
    marginBottom:    8,
  },
  contactIcon: {
    marginBottom: 10,
  },
  contactHeading: {
    color:        C.textPrimary,
    fontSize:     15,
    fontWeight:   '700',
    marginBottom: 6,
    textAlign:    'center',
  },
  contactBody: {
    color:        C.textSecondary,
    fontSize:     13,
    lineHeight:   19,
    textAlign:    'center',
    marginBottom: 16,
  },
  contactBtn: {
    backgroundColor: C.teal + '22',
    borderRadius:    10,
    paddingVertical:   10,
    paddingHorizontal: 18,
  },
  contactBtnText: {
    color:      C.teal,
    fontSize:   14,
    fontWeight: '600',
  },
});
