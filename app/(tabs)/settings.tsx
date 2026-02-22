// app/(tabs)/settings.tsx
// Settings: disconnect account, delete data, privacy, remove ads.

import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  ActivityIndicator,
  Linking,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { useAdStore, selectAdsActive } from '@/store/adStore';
import { RemoveAdsSheet } from '@/components/RemoveAdsSheet';
import C from '@/lib/colors';

export default function SettingsScreen() {
  const { user, igAccountId, setSession, setIgAccountId } = useAuthStore();
  const { adsRemovedUntil, consentStatus, setConsentStatus } = useAdStore();
  const adsActive = useAdStore(selectAdsActive);
  const qc = useQueryClient();

  const [disconnecting, setDisconnecting] = useState(false);
  const [deleting,      setDeleting]      = useState(false);
  const [showRemoveAds, setShowRemoveAds] = useState(false);

  // ── Disconnect IG account ─────────────────────────────────
  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect Instagram',
      'This will remove your IG account from StayReel. Your snapshot history is kept. You can reconnect any time.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            if (!igAccountId) return;
            setDisconnecting(true);
            try {
              await supabase
                .from('ig_accounts')
                .update({ status: 'disconnected', deleted_at: new Date().toISOString() })
                .eq('id', igAccountId);
              setIgAccountId(null);
              qc.clear();
            } catch (e: any) {
              Alert.alert('Error', e.message);
            } finally {
              setDisconnecting(false);
            }
          },
        },
      ],
    );
  };

  // ── Delete all data ───────────────────────────────────────
  const handleDeleteData = () => {
    Alert.alert(
      'Delete All Data',
      'This permanently deletes ALL snapshots, diffs, and your account. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete everything',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await supabase.from('profiles').delete().eq('id', user!.id);
              await supabase.auth.signOut();
              setSession(null);
              setIgAccountId(null);
              qc.clear();
            } catch (e: any) {
              Alert.alert('Error', e.message);
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  // ── Sign out ──────────────────────────────────────────────
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setIgAccountId(null);
    qc.clear();
  };

  // ── Consent toggle ────────────────────────────────────────
  const toggleConsent = (value: boolean) => {
    setConsentStatus(value ? 'granted' : 'denied');
  };

  const adsRemovedLabel = (() => {
    if (!adsRemovedUntil || Date.now() >= adsRemovedUntil) return null;
    const d = new Date(adsRemovedUntil);
    return `Expires ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  })();

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.screenTitle}>Settings</Text>

        {/* Account section */}
        <SectionHeader title="Account" />

        <SettingRow
          icon="person-circle-outline"
          iconColor={C.teal}
          title="Signed in as"
          value={user?.email ?? '—'}
        />

        <SettingRow
          icon="logo-instagram"
          iconColor={C.accent}
          title="Connected account"
          value={igAccountId ? 'Connected ✓' : 'Not connected'}
        />

        {igAccountId && (
          <ActionRow
            icon="unlink"
            iconColor={C.amber}
            title="Disconnect Instagram"
            onPress={handleDisconnect}
            loading={disconnecting}
            destructive={false}
          />
        )}

        {/* Ads section */}
        <SectionHeader title="Ads" />

        {adsActive && (
          <ActionRow
            icon="gift-outline"
            iconColor={C.green}
            title="Remove ads for 7 days"
            subtitle="Watch a short video — free"
            onPress={() => setShowRemoveAds(true)}
          />
        )}

        {adsRemovedLabel && (
          <SettingRow
            icon="checkmark-circle"
            iconColor={C.green}
            title="Ads removed"
            value={adsRemovedLabel}
          />
        )}

        {consentStatus !== 'unknown' && (
          <View style={styles.row}>
            <View style={[styles.iconWrap, { backgroundColor: C.tealDim }]}>
              <Ionicons name="eye-off-outline" size={18} color={C.teal} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle}>Personalised ads</Text>
              <Text style={styles.rowSub}>
                {consentStatus === 'granted' ? 'Enabled' : 'Disabled (non-personalised)'}
              </Text>
            </View>
            <Switch
              value={consentStatus === 'granted'}
              onValueChange={toggleConsent}
              trackColor={{ false: C.border, true: C.accentDim }}
              thumbColor={consentStatus === 'granted' ? C.accent : C.textMuted}
            />
          </View>
        )}

        {/* Privacy section */}
        <SectionHeader title="Privacy" />

        <ActionRow
          icon="document-text-outline"
          iconColor={C.textSecondary}
          title="Privacy Policy"
          onPress={() => Linking.openURL('https://example.com/privacy')}
        />

        <ActionRow
          icon="newspaper-outline"
          iconColor={C.textSecondary}
          title="Terms of Service"
          onPress={() => Linking.openURL('https://example.com/terms')}
        />

        {/* Danger zone */}
        <SectionHeader title="Danger Zone" />

        <ActionRow
          icon="trash-outline"
          iconColor={C.red}
          title="Delete all my data"
          subtitle="Permanently removes snapshots & account"
          onPress={handleDeleteData}
          loading={deleting}
          destructive
        />

        <ActionRow
          icon="log-out-outline"
          iconColor={C.textSecondary}
          title="Sign out"
          onPress={handleSignOut}
        />

        <Text style={styles.version}>StayReel v1.0.0</Text>
      </ScrollView>

      <RemoveAdsSheet visible={showRemoveAds} onClose={() => setShowRemoveAds(false)} />
    </SafeAreaView>
  );
}

// ── Sub-components ─────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <Text style={sStyles.header}>{title}</Text>
  );
}

interface SettingRowProps {
  icon:       string;
  iconColor:  string;
  title:      string;
  value:      string;
}
function SettingRow({ icon, iconColor, title, value }: SettingRowProps) {
  return (
    <View style={sStyles.row}>
      <View style={[sStyles.iconWrap, { backgroundColor: iconColor + '22' }]}>
        <Ionicons name={icon as any} size={18} color={iconColor} />
      </View>
      <View style={sStyles.rowBody}>
        <Text style={sStyles.rowTitle}>{title}</Text>
        <Text style={sStyles.rowSub}>{value}</Text>
      </View>
    </View>
  );
}

interface ActionRowProps {
  icon:        string;
  iconColor:   string;
  title:       string;
  subtitle?:   string;
  onPress:     () => void;
  loading?:    boolean;
  destructive?: boolean;
}
function ActionRow({ icon, iconColor, title, subtitle, onPress, loading, destructive }: ActionRowProps) {
  return (
    <TouchableOpacity style={sStyles.row} onPress={onPress} disabled={loading} activeOpacity={0.7}>
      <View style={[sStyles.iconWrap, { backgroundColor: iconColor + '22' }]}>
        <Ionicons name={icon as any} size={18} color={iconColor} />
      </View>
      <View style={sStyles.rowBody}>
        <Text style={[sStyles.rowTitle, destructive && { color: C.red }]}>{title}</Text>
        {subtitle && <Text style={sStyles.rowSub}>{subtitle}</Text>}
      </View>
      {loading
        ? <ActivityIndicator size="small" color={C.textMuted} />
        : <Ionicons name="chevron-forward" size={16} color={C.textMuted} />
      }
    </TouchableOpacity>
  );
}

// outer styles
const styles = StyleSheet.create({
  safe:   { flex: 1, backgroundColor: C.black },
  scroll: { padding: 16, paddingBottom: 48 },
  screenTitle: {
    color:      C.textPrimary,
    fontSize:   26,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 16,
  },
  row: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         14,
    gap:             12,
    marginBottom:    8,
  },
  iconWrap: {
    width:          38,
    height:         38,
    borderRadius:   10,
    alignItems:     'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1 },
  rowTitle: { color: C.textPrimary, fontSize: 15, fontWeight: '500' },
  rowSub:   { color: C.textMuted, fontSize: 12, marginTop: 2 },
  version:  { color: C.textMuted, fontSize: 12, textAlign: 'center', marginTop: 24 },
});

// shared sub-component styles (mirrored from outer but scoped)
const sStyles = StyleSheet.create({
  header: {
    color:      C.textMuted,
    fontSize:   12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginTop:   16,
    marginBottom: 8,
  },
  row: {
    flexDirection:   'row',
    alignItems:      'center',
    backgroundColor: C.surface,
    borderRadius:    14,
    padding:         14,
    gap:             12,
    marginBottom:    8,
  },
  iconWrap: {
    width:          38,
    height:         38,
    borderRadius:   10,
    alignItems:     'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1 },
  rowTitle: { color: C.textPrimary, fontSize: 15, fontWeight: '500' },
  rowSub:   { color: C.textMuted, fontSize: 12, marginTop: 2 },
});
