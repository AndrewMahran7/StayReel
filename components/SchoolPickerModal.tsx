// components/SchoolPickerModal.tsx
// Full-screen modal shown once to new users to collect school attribution.
// Dismissed permanently by selecting a school or tapping "Don't ask again".

import React, { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import C from '@/lib/colors';
import { SCHOOLS } from '@/lib/schools';
import { supabase } from '@/lib/supabase';

interface Props {
  visible: boolean;
  userId: string;
  onDone: () => void;   // called after persistence succeeds
}

export function SchoolPickerModal({ visible, userId, onDone }: Props) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [saving, setSaving]     = useState(false);

  const handleSelect = async (schoolId: string) => {
    setSelected(schoolId);
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('profiles')
        .update({
          school:             schoolId,
          school_selected_at: now,
          school_do_not_ask:  true,   // don't show again regardless
          updated_at:         now,
        })
        .eq('id', userId);
      if (error) throw error;
      // Refresh the shared school query so Settings and other screens update
      qc.setQueryData(['profile-school', userId], schoolId);
      qc.invalidateQueries({ queryKey: ['profile-school', userId] });
      onDone();
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      console.warn('[SchoolPicker] update error:', msg);
      // Keep the modal open so the user can retry
      Alert.alert(
        'Could not save',
        __DEV__
          ? `DB error: ${msg}`
          : 'School selection failed to save. Please check your connection and try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDismiss = async () => {
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('profiles')
        .update({
          school_do_not_ask:  true,
          school_selected_at: now,
          updated_at:         now,
        })
        .eq('id', userId);
      if (error) console.warn('[SchoolPicker] dismiss update error:', error.message);
    } catch (err: any) {
      console.warn('[SchoolPicker] dismiss error:', err?.message);
    } finally {
      setSaving(false);
      onDone();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent statusBarTranslucent>
      <View style={s.backdrop}>
        <View style={s.card}>
          {/* Header */}
          <View style={s.header}>
            <Ionicons name="school-outline" size={32} color={C.teal} />
            <Text style={s.title}>What school do you go to?</Text>
            <Text style={s.subtitle}>
              This helps us connect you with your campus ambassador. You can change this later in Settings.
            </Text>
          </View>

          {/* School list */}
          <View style={s.list}>
            {SCHOOLS.map((school) => {
              const isSelected = selected === school.id;
              return (
                <TouchableOpacity
                  key={school.id}
                  style={[s.option, isSelected && s.optionSelected]}
                  onPress={() => handleSelect(school.id)}
                  disabled={saving}
                  activeOpacity={0.7}
                >
                  <Text style={[s.optionText, isSelected && s.optionTextSelected]}>
                    {school.label}
                  </Text>
                  {isSelected && saving ? (
                    <ActivityIndicator size="small" color={C.teal} />
                  ) : isSelected ? (
                    <Ionicons name="checkmark-circle" size={20} color={C.teal} />
                  ) : (
                    <Ionicons name="ellipse-outline" size={20} color={C.textMuted} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Dismiss link */}
          <TouchableOpacity
            style={s.dismissBtn}
            onPress={handleDismiss}
            disabled={saving}
            activeOpacity={0.7}
          >
            <Text style={s.dismissText}>Don't ask again</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  card: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 28,
    paddingBottom: 36,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  title: {
    color: C.textPrimary,
    fontSize: 20,
    fontWeight: '700',
    marginTop: 12,
    textAlign: 'center',
  },
  subtitle: {
    color: C.textSecondary,
    fontSize: 13,
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: 8,
  },
  list: {
    gap: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: C.black,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: C.border,
  },
  optionSelected: {
    borderColor: C.teal,
    backgroundColor: C.tealDim,
  },
  optionText: {
    color: C.textPrimary,
    fontSize: 15,
    fontWeight: '500',
  },
  optionTextSelected: {
    color: C.teal,
  },
  dismissBtn: {
    alignSelf: 'center',
    marginTop: 18,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  dismissText: {
    color: C.textMuted,
    fontSize: 13,
    fontWeight: '500',
  },
});
