// components/ReferralCodeModal.tsx
// Full-screen modal shown once to new users to collect ambassador attribution.
// Dismissed permanently via "Apply Code" (success) or "Skip" (sets a flag).
//
// UX: the copy is designed to make entering a code feel normal, expected,
// and socially motivated — "This code supports the creator who sent you."

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { supabase } from '@/lib/supabase';
import { setReferralAttribute } from '@/lib/revenueCat';
import { trackEvent } from '@/lib/analytics';
import C from '@/lib/colors';

interface Props {
  visible:  boolean;
  userId:   string;
  onDone:   () => void;   // called after apply or skip
}

export function ReferralCodeModal({ visible, userId, onDone }: Props) {
  const [code, setCode]       = useState('');
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const handleApply = async () => {
    const trimmed = code.trim().toLowerCase();
    if (!trimmed) {
      setError('Please enter a referral code.');
      return;
    }
    if (!/^[a-z0-9_-]{3,30}$/.test(trimmed)) {
      setError('Codes are 3–30 characters: letters, numbers, hyphens, or underscores only.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/set-referral`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session?.access_token ?? ''}`,
            apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
          },
          body: JSON.stringify({ code: trimmed }),
        },
      );

      // Defensive: parse JSON safely — gateway errors may return HTML
      let json: Record<string, unknown> | null = null;
      try {
        json = await res.json();
      } catch {
        // Response body was not valid JSON (e.g. 502 HTML page)
      }

      // Non-2xx without a structured body — treat as server error
      if (!res.ok && !json?.error) {
        setError('Something went wrong. Please try again.');
        return;
      }

      // ── Handle structured responses ────────────────────────
      if (json?.success === true) {
        setReferralAttribute(trimmed);
        trackEvent('referral_applied', { code: trimmed, source: 'modal' });
        onDone();
        return;
      }

      // Map known error codes to user-friendly messages
      const errorCode = json?.error as string | undefined;
      switch (errorCode) {
        case 'code_not_found':
          setError("That code doesn't exist. Check the spelling and try again.");
          break;
        case 'code_unavailable':
          setError('That code is no longer available.');
          break;
        case 'already_attributed':
          // Already has a code — close silently (no disruptive error)
          onDone();
          break;
        case 'server_error':
          setError('Unable to verify the code right now. Please try again in a moment.');
          break;
        default:
          setError('Something went wrong. Please try again.');
          break;
      }
    } catch (err: any) {
      // Network failure, timeout, etc.
      console.warn('[ReferralCode] apply error:', err?.message ?? err);
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    // Mark the prompt as dismissed so it doesn't show again.
    // We store a sentinel value in referral_source to suppress re-prompts
    // without burning the referred_by column.
    try {
      const { error: skipErr } = await supabase
        .from('profiles')
        .update({
          referral_source: '__skipped__',
          updated_at:      new Date().toISOString(),
        })
        .eq('id', userId);

      if (skipErr) {
        console.warn('[ReferralCode] skip write failed:', skipErr.message);
        // Non-critical — the useReferralPrompt hook's dismissedRef will still
        // prevent the modal from re-appearing this session.
      }
    } catch (e) {
      console.warn('[ReferralCode] skip error:', e);
    }
    onDone();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={s.backdrop}
      >
        <View style={s.card}>
          {/* Icon */}
          <View style={s.iconCircle}>
            <Ionicons name="gift" size={28} color={C.accent} />
          </View>

          {/* Title */}
          <Text style={s.title}>Did someone send you StayReel?</Text>
          <Text style={s.subtitle}>
            Enter their code so they get credit.
          </Text>

          {/* Input */}
          <TextInput
            style={s.input}
            placeholder="e.g. andrea, jenny2026"
            placeholderTextColor={C.textMuted}
            value={code}
            onChangeText={(t) => { setCode(t); setError(null); }}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={30}
            returnKeyType="done"
            onSubmitEditing={handleApply}
          />

          {/* Error — always rendered so the card height never shifts */}
          <Text style={s.error}>{error ?? ''}</Text>

          {/* Helper text — social motivation */}
          <View style={s.helperRow}>
            <Ionicons name="heart" size={14} color={C.accent} />
            <Text style={s.helperText}>
              Creators earn commission when you use their code
            </Text>
          </View>

          {/* CTA */}
          <TouchableOpacity
            style={[s.applyBtn, !code.trim() && s.applyBtnDisabled]}
            onPress={handleApply}
            disabled={saving || !code.trim()}
            activeOpacity={0.8}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={18} color="#fff" style={{ marginRight: 6 }} />
                <Text style={s.applyBtnText}>Apply Code</Text>
              </>
            )}
          </TouchableOpacity>

          {/* Skip */}
          <TouchableOpacity style={s.skipBtn} onPress={handleSkip} disabled={saving}>
            <Text style={s.skipText}>I don't have a code</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex:            1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent:  'center',
    alignItems:      'center',
    padding:         24,
  },
  card: {
    backgroundColor: C.surface,
    borderRadius:    20,
    padding:         24,
    width:           '100%',
    maxWidth:        380,
    alignItems:      'center',
  },
  iconCircle: {
    width:           56,
    height:          56,
    borderRadius:    28,
    backgroundColor: C.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
    marginBottom:    16,
  },
  title: {
    color:      C.textPrimary,
    fontSize:   20,
    fontWeight: '700',
    textAlign:  'center',
    marginBottom: 6,
  },
  subtitle: {
    color:      C.textSecondary,
    fontSize:   14,
    textAlign:  'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  input: {
    width:           '100%',
    backgroundColor: C.black,
    borderRadius:    12,
    borderWidth:     1,
    borderColor:     C.border,
    paddingHorizontal: 16,
    paddingVertical:   14,
    color:           C.textPrimary,
    fontSize:        16,
    marginBottom:    8,
  },
  error: {
    color:    C.red,
    fontSize: 12,
    minHeight: 16,      // reserved space — prevents layout shift on error show/hide
    marginBottom: 4,
    alignSelf: 'flex-start',
  },
  helperRow: {
    flexDirection: 'row',
    alignItems:    'center',
    gap:           6,
    marginBottom:  20,
    marginTop:     4,
  },
  helperText: {
    color:    C.textMuted,
    fontSize: 12,
  },
  applyBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    backgroundColor:   C.accent,
    borderRadius:      14,
    paddingVertical:   14,
    width:             '100%',
    marginBottom:      12,
  },
  applyBtnDisabled: {
    opacity: 0.5,
  },
  applyBtnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '600',
  },
  skipBtn: {
    paddingVertical: 8,
  },
  skipText: {
    color:    C.textMuted,
    fontSize: 13,
  },
});
