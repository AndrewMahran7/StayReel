// components/PromoCodeModal.tsx
// Bottom-sheet-style modal for entering and redeeming a promo code.

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import C from '@/lib/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function PromoCodeModal({ visible, onClose }: Props) {
  const [code, setCode]       = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult]   = useState<{ ok: boolean; message: string } | null>(null);
  const redeemPromo = useSubscriptionStore((s) => s.redeemPromo);

  const handleRedeem = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setLoading(true);
    setResult(null);

    const res = await redeemPromo(trimmed);
    setResult(res);
    setLoading(false);

    // Auto-close on success after a brief delay
    if (res.ok) {
      setTimeout(() => {
        setCode('');
        setResult(null);
        onClose();
      }, 2000);
    }
  };

  const handleClose = () => {
    setCode('');
    setResult(null);
    onClose();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.backdrop}
      >
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={handleClose}
        >
          <TouchableOpacity activeOpacity={1} style={styles.sheet}>
            {/* Header */}
            <View style={styles.header}>
              <Text style={styles.title}>Enter Promo Code</Text>
              <TouchableOpacity onPress={handleClose} hitSlop={16}>
                <Ionicons name="close" size={22} color={C.textMuted} />
              </TouchableOpacity>
            </View>

            <Text style={styles.subtitle}>
              Got a code? Enter it below to unlock free Pro access.
            </Text>

            {/* Input */}
            <TextInput
              style={styles.input}
              value={code}
              onChangeText={(v) => {
                setCode(v);
                setResult(null);
              }}
              placeholder="e.g. BETA2026"
              placeholderTextColor={C.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={handleRedeem}
              editable={!loading}
            />

            {/* Result message */}
            {result && (
              <View style={[styles.resultRow, result.ok ? styles.resultOk : styles.resultErr]}>
                <Ionicons
                  name={result.ok ? 'checkmark-circle' : 'alert-circle'}
                  size={18}
                  color={result.ok ? C.green : C.red}
                />
                <Text style={[styles.resultText, { color: result.ok ? C.green : C.red }]}>
                  {result.message}
                </Text>
              </View>
            )}

            {/* Button */}
            <TouchableOpacity
              style={[styles.btn, (!code.trim() || loading) && styles.btnDisabled]}
              onPress={handleRedeem}
              disabled={!code.trim() || loading}
            >
              {loading ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnText}>Redeem</Text>
              )}
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 24,
    paddingBottom: 40,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  title: {
    color: C.textPrimary,
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: C.textSecondary,
    fontSize: 14,
    marginBottom: 20,
    lineHeight: 20,
  },
  input: {
    backgroundColor: C.surfaceAlt,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: C.textPrimary,
    fontSize: 16,
    borderWidth: 1,
    borderColor: C.border,
    marginBottom: 16,
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    gap: 8,
  },
  resultOk: {
    backgroundColor: C.greenDim,
  },
  resultErr: {
    backgroundColor: C.redDim,
  },
  resultText: {
    fontSize: 14,
    flex: 1,
  },
  btn: {
    backgroundColor: C.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
