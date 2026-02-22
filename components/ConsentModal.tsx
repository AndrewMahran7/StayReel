// components/ConsentModal.tsx
// Simple first-launch consent banner.
// In production replace with the Google UMP SDK for full GDPR compliance.

import React from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Linking,
} from 'react-native';
import { useAdStore } from '@/store/adStore';
import C from '@/lib/colors';

export function ConsentModal() {
  const { consentStatus, setConsentStatus } = useAdStore();

  if (consentStatus !== 'unknown') return null;

  return (
    <Modal transparent animationType="fade" visible>
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.title}>Personalised Ads</Text>
          <Text style={styles.body}>
            StayReel is free and supported by ads. We&apos;d like to show you
            personalised ads based on your interests. You can change this at any
            time in Settings.{'\n\n'}
            Tap <Text style={styles.bold}>Accept</Text> to see personalised ads,
            or <Text style={styles.bold}>Decline</Text> for non-personalised ads.
          </Text>

          <TouchableOpacity
            onPress={() => Linking.openURL('https://policies.google.com/privacy')}
          >
            <Text style={styles.link}>Google Privacy Policy →</Text>
          </TouchableOpacity>

          <View style={styles.row}>
            <TouchableOpacity
              style={[styles.btn, styles.btnOutline]}
              onPress={() => setConsentStatus('denied')}
            >
              <Text style={styles.btnOutlineText}>Decline</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnAccent]}
              onPress={() => setConsentStatus('granted')}
            >
              <Text style={styles.btnAccentText}>Accept</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: C.surfaceAlt,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    gap: 16,
  },
  title: {
    color: C.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  body: {
    color: C.textSecondary,
    fontSize: 14,
    lineHeight: 22,
  },
  bold: {
    color: C.textPrimary,
    fontWeight: '600',
  },
  link: {
    color: C.teal,
    fontSize: 13,
  },
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  btn: {
    flex: 1,
    height: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOutline: {
    borderWidth: 1,
    borderColor: C.border,
  },
  btnOutlineText: {
    color: C.textSecondary,
    fontWeight: '600',
  },
  btnAccent: {
    backgroundColor: C.accent,
  },
  btnAccentText: {
    color: '#fff',
    fontWeight: '700',
  },
});
