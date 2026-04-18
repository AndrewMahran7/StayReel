// components/PaywallModal.tsx
// Paywall modal wrapping the native RevenueCat Paywall UI.
//
// When RevenueCat is configured → renders the RC native paywall in a Modal.
// When RC is unavailable → renders a fallback "not available" screen.
//
// The same <PaywallModal visible onClose /> API is preserved so
// dashboard.tsx and settings.tsx don't need structural changes.

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import RevenueCatUI from 'react-native-purchases-ui';

import { isRevenueCatConfigured, getRevenueCatConfigError, isProFromInfo } from '@/lib/revenueCat';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { trackEvent }           from '@/lib/analytics';
import { isBetaActive }         from '@/lib/betaAccess';
import C from '@/lib/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function PaywallModal({ visible, onClose }: Props) {
  const setProFromInfo = useSubscriptionStore((s) => s.setProFromInfo);

  // Track paywall impression once per open
  const trackedRef = useRef(false);
  useEffect(() => {
    if (visible && !trackedRef.current) {
      trackedRef.current = true;
      trackEvent('paywall_opened');
    }
    if (!visible) trackedRef.current = false;
  }, [visible]);

  if (!visible) return null;

  // ── Beta access: suppress paywall, show lightweight message ──
  if (isBetaActive()) {
    trackEvent('paywall_suppressed', { reason: 'beta_active' });
    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.fallback}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={16}>
            <Ionicons name="close" size={24} color={C.textMuted} />
          </TouchableOpacity>

          <View style={styles.betaBadgeCircle}>
            <Ionicons name="star" size={28} color={C.accent} />
          </View>
          <Text style={styles.fallbackTitle}>You have Pro access</Text>
          <Text style={styles.fallbackText}>
            All Pro features are free during the beta period.{'\n'}
            Enjoy full access to every list and feature!
          </Text>
          <View style={styles.betaChip}>
            <Text style={styles.betaChipText}>BETA ACCESS</Text>
          </View>
          <TouchableOpacity style={styles.fallbackBtn} onPress={onClose}>
            <Text style={styles.fallbackBtnText}>Got it</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  // ── Fallback when RevenueCat isn't configured ────────────────
  if (!isRevenueCatConfigured()) {
    const reason = getRevenueCatConfigError();
    const isEnvIssue =
      reason != null &&
      (/Play|StoreKit|Simulator/i.test(reason));

    return (
      <Modal
        visible
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={onClose}
      >
        <SafeAreaView style={styles.fallback}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose} hitSlop={16}>
            <Ionicons name="close" size={24} color={C.textMuted} />
          </TouchableOpacity>

          <Ionicons
            name={isEnvIssue ? 'information-circle-outline' : 'alert-circle-outline'}
            size={48}
            color={isEnvIssue ? C.textSecondary : C.amber}
          />
          <Text style={styles.fallbackTitle}>
            {isEnvIssue ? 'Purchases Not Supported Here' : 'Purchases Unavailable'}
          </Text>
          <Text style={styles.fallbackText}>
            {reason ??
              `In-app purchases are not available right now. Please make sure you're on a device with ${
                Platform.OS === 'android' ? 'Google Play' : 'the App Store'
              } and try again later.`}
          </Text>
          {isEnvIssue && (
            <Text style={[styles.fallbackText, { fontSize: 12, marginTop: -12 }]}>
              To test subscriptions, use a physical iOS device signed in to a
              Sandbox Apple ID in Settings → App Store.
            </Text>
          )}
          <TouchableOpacity style={styles.fallbackBtn} onPress={onClose}>
            <Text style={styles.fallbackBtnText}>Close</Text>
          </TouchableOpacity>
        </SafeAreaView>
      </Modal>
    );
  }

  // ── Native RevenueCat Paywall ────────────────────────────────
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        <RevenueCatUI.Paywall
          options={{ displayCloseButton: true }}
          onPurchaseCompleted={({ customerInfo }) => {
            trackEvent('purchase_completed', {
              entitlements: Object.keys(customerInfo.entitlements.active),
            });
            setProFromInfo(customerInfo);
            onClose();
          }}
          onRestoreCompleted={({ customerInfo }) => {
            if (isProFromInfo(customerInfo)) {
              setProFromInfo(customerInfo);
              onClose();
            }
          }}
          onDismiss={onClose}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.black,
  },
  fallback: {
    flex: 1,
    backgroundColor: C.black,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  closeBtn: {
    position: 'absolute',
    top: 16,
    right: 16,
    zIndex: 10,
    padding: 8,
  },
  fallbackTitle: {
    color: C.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  fallbackText: {
    color: C.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 28,
  },
  fallbackBtn: {
    backgroundColor: C.accent,
    borderRadius: 50,
    paddingVertical: 14,
    paddingHorizontal: 40,
  },
  fallbackBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  betaBadgeCircle: {
    width:           56,
    height:          56,
    borderRadius:    28,
    backgroundColor: C.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
    marginBottom:    8,
  },
  betaChip: {
    backgroundColor: C.accentDim,
    borderRadius:    12,
    paddingVertical:  4,
    paddingHorizontal: 12,
    marginBottom:    24,
  },
  betaChipText: {
    color:        C.accent,
    fontSize:     11,
    fontWeight:   '700',
    letterSpacing: 1,
  },
});
