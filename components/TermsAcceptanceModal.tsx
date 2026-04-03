// components/TermsAcceptanceModal.tsx
// Full-screen modal requiring Terms of Service + Privacy Policy acceptance
// before the user can connect their Instagram account or take snapshots.

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import C from '@/lib/colors';

/** Bump this string whenever Terms or Privacy Policy require re-acceptance. */
export const CURRENT_TERMS_VERSION = '2026-04-02';

const TERMS_URL   = 'https://andrewmahran7.github.io/stayreel-legal/terms';
const PRIVACY_URL = 'https://andrewmahran7.github.io/stayreel-legal/privacy';

interface Props {
  visible: boolean;
  onAccepted: () => void;
}

export function TermsAcceptanceModal({ visible, onAccepted }: Props) {
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setTermsAccepted = useAuthStore((s) => s.setTermsAccepted);

  const handleAccept = async () => {
    if (!user || loading) return;
    setLoading(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('profiles')
        .update({
          terms_accepted_at: now,
          terms_version: CURRENT_TERMS_VERSION,
          updated_at: now,
        })
        .eq('id', user.id);

      if (error) {
        console.warn('[Terms] Failed to save acceptance:', error.message);
        // Still allow through — the record attempt is logged and the worst
        // case is they'll be re-prompted next launch.
      }

      setTermsAccepted(true);
      onAccepted();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          {/* Icon */}
          <View style={styles.iconWrap}>
            <Ionicons name="document-text-outline" size={40} color={C.accent} />
          </View>

          <Text style={styles.title}>Before you continue</Text>

          <Text style={styles.body}>
            To use StayReel, please review and accept our Terms of Service and
            Privacy Policy.
          </Text>

          <Text style={styles.body}>
            By tapping "I Agree" below, you acknowledge that:
          </Text>

          <View style={styles.bulletList}>
            <BulletPoint text="StayReel accesses your Instagram followers and following lists using a session token you provide." />
            <BulletPoint text="Instagram may occasionally request you to re-verify your account. This is a normal platform security measure and is not caused by StayReel." />
            <BulletPoint text="StayReel is not affiliated with Instagram or Meta Platforms, Inc." />
            <BulletPoint text="Your data is stored securely and never sold or shared with third parties." />
          </View>

          {/* Links */}
          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL(TERMS_URL)}
            activeOpacity={0.7}
          >
            <Ionicons name="open-outline" size={14} color={C.accent} />
            <Text style={styles.linkText}>Read Terms of Service</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.linkRow}
            onPress={() => Linking.openURL(PRIVACY_URL)}
            activeOpacity={0.7}
          >
            <Ionicons name="open-outline" size={14} color={C.accent} />
            <Text style={styles.linkText}>Read Privacy Policy</Text>
          </TouchableOpacity>
        </ScrollView>

        {/* Accept button — pinned to bottom */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.acceptBtn, loading && styles.acceptBtnDisabled]}
            onPress={handleAccept}
            disabled={loading}
            activeOpacity={0.85}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.acceptBtnText}>I Agree — Continue</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.finePrint}>
            You can review these documents at any time from Settings.
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function BulletPoint({ text }: { text: string }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: C.black,
  },
  scroll: {
    padding: 24,
    paddingTop: 40,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: C.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: 24,
  },
  title: {
    color: C.textPrimary,
    fontSize: 24,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 16,
    letterSpacing: -0.3,
  },
  body: {
    color: C.textSecondary,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 12,
  },
  bulletList: {
    marginBottom: 20,
    marginTop: 4,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
    paddingRight: 8,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
    marginTop: 7,
    marginRight: 10,
    flexShrink: 0,
  },
  bulletText: {
    flex: 1,
    color: C.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  linkText: {
    color: C.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  footer: {
    padding: 24,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: C.border,
  },
  acceptBtn: {
    backgroundColor: C.accent,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  acceptBtnDisabled: {
    opacity: 0.6,
  },
  acceptBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  finePrint: {
    color: C.textMuted,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 12,
  },
});
