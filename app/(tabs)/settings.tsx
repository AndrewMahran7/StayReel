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
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useRouter } from 'expo-router';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { useAdStore } from '@/store/adStore';
import { useSubscriptionStore } from '@/store/subscriptionStore';
import { RemoveAdsSheet } from '@/components/RemoveAdsSheet';
import { PaywallModal } from '@/components/PaywallModal';
import { unregisterPushToken } from '@/lib/notifications';
import { showCustomerCenter, restorePurchases, isProFromInfo } from '@/lib/revenueCat';
import { useNotificationSettings, NotificationPrefs } from '@/hooks/useNotificationSettings';
import { SchoolPickerModal } from '@/components/SchoolPickerModal';
import { ReferralCodeModal } from '@/components/ReferralCodeModal';
import { schoolLabel } from '@/lib/schools';
import C from '@/lib/colors';

export default function SettingsScreen() {
  const router = useRouter();
  const { user, igAccountId, setSession, setIgAccountId } = useAuthStore();
  const { adsRemovedUntil } = useAdStore();
  const adsActive = !adsRemovedUntil || Date.now() >= adsRemovedUntil;
  const qc = useQueryClient();

  const [disconnecting, setDisconnecting] = useState(false);
  const [deleting,      setDeleting]      = useState(false);
  const [restoring,    setRestoring]      = useState(false);
  const [showRemoveAds, setShowRemoveAds] = useState(false);
  const [showPaywall, setShowPaywall] = useState(false);
  const [showSchoolPicker, setShowSchoolPicker] = useState(false);
  const [showReferralModal, setShowReferralModal] = useState(false);
  const { settings: notifPrefs, update: updateNotifPref } = useNotificationSettings();

  // Subscription
  const isPro  = useSubscriptionStore((s) => s.isPro);
  const status = useSubscriptionStore((s) => s.status);
  const expiresAt = useSubscriptionStore((s) => s.expiresAt);

  const planLabel = isPro
    ? status === 'trial' ? 'Free Trial' : 'Pro'
    : 'Free';

  const expiryLabel = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  // School attribution — shared query key so picker invalidation refreshes here
  const { data: schoolId = null } = useQuery<string | null>({
    queryKey: ['profile-school', user?.id],
    enabled: !!user,
    staleTime: 60_000,    // refetch periodically instead of never
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('school')
        .eq('id', user!.id)
        .maybeSingle();
      return data?.school ?? null;
    },
  });

  // Referral code — read-only display (or tap to enter if already skipped the auto-prompt)
  const { data: referralData, refetch: refetchReferral } = useQuery<{
    referredBy: string | null;
    skipped: boolean;
  }>({
    queryKey: ['profile-referral', user?.id],
    enabled: !!user,
    staleTime: 0,   // always re-fetch so skip state is immediately visible
    queryFn: async () => {
      const { data } = await supabase
        .from('profiles')
        .select('referred_by, referral_source')
        .eq('id', user!.id)
        .maybeSingle();
      const result = {
        referredBy: data?.referred_by ?? null,
        skipped: data?.referral_source === '__skipped__',
      };
      console.log('[Settings:referral] query result:', {
        currentUserId: user!.id,
        referred_by: result.referredBy,
        referral_source: data?.referral_source ?? null,
        hasReferral: result.referredBy !== null,
        hasSkippedReferral: result.skipped,
      });
      return result;
    },
  });
  const referredBy          = referralData?.referredBy ?? null;
  const hasReferral         = referredBy !== null;
  const hasSkippedReferral  = referralData?.skipped === true;
  // Show the manual-entry row only when user has skipped the auto-prompt.
  // While referralData is loading (undefined) we default to false to avoid flash.
  const showReferralRow        = hasReferral || hasSkippedReferral;
  const isSettingsReferralOpen = showReferralModal;

  console.log('[Settings:referral] visibility:', {
    currentUserId:              user?.id ?? 'none',
    hasReferral,
    hasSkippedReferral,
    shouldShowSettingsReferralEntry: !hasReferral && hasSkippedReferral,
    isSettingsReferralOpen,
    showReferralRow,
  });

  const toggleNotif = (key: keyof NotificationPrefs) => {
    updateNotifPref({ [key]: !notifPrefs[key] }).catch(() =>
      Alert.alert('Error', 'Could not save notification preference.'),
    );
  };

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
    // Detach push token BEFORE destroying the session — the
    // RLS-protected profile update requires an active JWT.
    await unregisterPushToken().catch(() => {});
    await supabase.auth.signOut();
    setSession(null);
    setIgAccountId(null);
    qc.clear();
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

        <ActionRow
          icon="school-outline"
          iconColor={C.teal}
          title="School"
          subtitle={schoolLabel(schoolId)}
          onPress={() => setShowSchoolPicker(true)}
        />

        {showReferralRow && (
          referredBy ? (
            <SettingRow
              icon="gift-outline"
              iconColor={C.accent}
              title="Referral code"
              value={referredBy}
            />
          ) : (
            <ActionRow
              icon="gift-outline"
              iconColor={C.accent}
              title="Enter referral code"
              subtitle="Support the creator who sent you"
              onPress={() => setShowReferralModal(true)}
            />
          )
        )}

        {/* Subscription section */}
        <SectionHeader title="Subscription" />

        <SettingRow
          icon="diamond-outline"
          iconColor={C.teal}
          title="Current plan"
          value={planLabel}
        />

        {isPro && expiryLabel && (
          <SettingRow
            icon="calendar-outline"
            iconColor={C.textSecondary}
            title={status === 'trial' ? 'Trial ends' : 'Renews'}
            value={expiryLabel}
          />
        )}

        {!isPro && (
          <ActionRow
            icon="rocket-outline"
            iconColor={C.accent}
            title="Upgrade to Pro"
            subtitle="See your full follower lists & more"
            onPress={() => setShowPaywall(true)}
          />
        )}

        {!isPro && (
          <ActionRow
            icon="refresh-outline"
            iconColor={C.textSecondary}
            title="Restore Purchases"
            subtitle="Already subscribed on another device?"
            loading={restoring}
            onPress={async () => {
              if (restoring) return;
              setRestoring(true);
              try {
                const info = await restorePurchases();
                if (isProFromInfo(info)) {
                  useSubscriptionStore.getState().setProFromInfo(info);
                  Alert.alert('Restored', 'Your subscription has been restored.');
                } else {
                  Alert.alert('No Subscription', "We couldn't find an active subscription for this account.");
                }
              } catch (e: any) {
                Alert.alert('Error', e?.message ?? 'Restore failed.');
              } finally {
                setRestoring(false);
              }
            }}
          />
        )}

        {isPro && (
          <ActionRow
            icon="settings-outline"
            iconColor={C.textSecondary}
            title="Manage subscription"
            subtitle="Change plan, cancel, or get help"
            onPress={() => showCustomerCenter()}
          />
        )}

        {isPro && (
          <ActionRow
            icon="close-circle-outline"
            iconColor={C.red}
            title="Cancel subscription"
            subtitle={Platform.OS === 'ios' ? 'Opens App Store settings' : 'Opens Play Store settings'}
            onPress={() => {
              const url =
                Platform.OS === 'ios'
                  ? 'https://apps.apple.com/account/subscriptions'
                  : 'https://play.google.com/store/account/subscriptions';
              Linking.openURL(url);
            }}
          />
        )}

        {/* Notifications section */}
        <SectionHeader title="Notifications" />

        <ToggleRow
          icon="checkmark-done-outline"
          iconColor={C.green}
          title="Snapshot ready"
          subtitle="When your follower refresh finishes"
          value={notifPrefs.notify_refresh_complete}
          onToggle={() => toggleNotif('notify_refresh_complete')}
        />

        <ToggleRow
          icon="calendar-outline"
          iconColor={C.teal}
          title="Weekly summary"
          subtitle="Your follower movement each week"
          value={notifPrefs.notify_weekly_summary}
          onToggle={() => toggleNotif('notify_weekly_summary')}
        />

        <ToggleRow
          icon="people-outline"
          iconColor={C.accent}
          title="Unfollow alerts"
          subtitle="Included in your weekly summary"
          value={notifPrefs.notify_on_unfollow}
          onToggle={() => toggleNotif('notify_on_unfollow')}
        />

        <ToggleRow
          icon="key-outline"
          iconColor={C.textMuted}
          title="Session expiry"
          subtitle="Coming soon"
          value={false}
          onToggle={() => {}}
          disabled
        />

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

        {/* Privacy section */}
        <SectionHeader title="Privacy" />

        <ActionRow
          icon="document-text-outline"
          iconColor={C.textSecondary}
          title="Privacy Policy"
          onPress={() => Linking.openURL('https://andrewmahran7.github.io/stayreel-legal/privacy')}
        />

        <ActionRow
          icon="newspaper-outline"
          iconColor={C.textSecondary}
          title="Terms of Service"
          onPress={() => Linking.openURL('https://andrewmahran7.github.io/stayreel-legal/terms')}
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

        {/* Our Promise */}
        <SectionHeader title="About" />
        <ActionRow
          icon="heart-circle-outline"
          iconColor={C.teal}
          title="Our Promise"
          subtitle="What we stand for — and what we'll never do."
          onPress={() => router.push('/our-promise')}
        />
        <ActionRow
          icon="help-circle-outline"
          iconColor={C.accent}
          title="Troubleshooting"
          subtitle="Common errors and how to fix them."
          onPress={() => router.push('/troubleshooting')}
        />

        <Text style={styles.version}>StayReel v1.0.0</Text>
      </ScrollView>

      <RemoveAdsSheet visible={showRemoveAds} onClose={() => setShowRemoveAds(false)} />
      <PaywallModal visible={showPaywall} onClose={() => setShowPaywall(false)} />
      <SchoolPickerModal
        visible={showSchoolPicker}
        userId={user?.id ?? ''}
        onDone={() => setShowSchoolPicker(false)}
      />
      <ReferralCodeModal
        visible={showReferralModal}
        userId={user?.id ?? ''}
        onDone={() => {
          setShowReferralModal(false);
          refetchReferral();
        }}
      />
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

interface ToggleRowProps {
  icon:      string;
  iconColor: string;
  title:     string;
  subtitle?: string;
  value:     boolean;
  onToggle:  () => void;
  disabled?: boolean;
}
function ToggleRow({ icon, iconColor, title, subtitle, value, onToggle, disabled }: ToggleRowProps) {
  return (
    <View style={[sStyles.row, disabled && { opacity: 0.45 }]}>
      <View style={[sStyles.iconWrap, { backgroundColor: iconColor + '22' }]}>
        <Ionicons name={icon as any} size={18} color={iconColor} />
      </View>
      <View style={sStyles.rowBody}>
        <Text style={sStyles.rowTitle}>{title}</Text>
        {subtitle && <Text style={sStyles.rowSub}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        disabled={disabled}
        trackColor={{ false: '#3e3e3e', true: C.accent + '88' }}
        thumbColor={value ? C.accent : '#888'}
      />
    </View>
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
