// components/SnapshotErrorCard.tsx
// Rich error card shown on the dashboard after a snapshot job fails.
// Maps known Instagram error codes to tailored guidance; falls back to a
// generic "developers have been alerted" message for unexpected errors.

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import C from '@/lib/colors';
import { SnapshotError } from '@/hooks/useSnapshotCapture';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

// ── Error profile map ─────────────────────────────────────────────────────────

interface ErrorProfile {
  icon:    string;
  color:   string;
  bgColor: string;
  title:   string;
  body:    string;
  steps:   string[];
  /** If true, show a "Go to Settings → Reconnect" button */
  needsReconnect: boolean;
  /** If true, show a Sign Out button */
  needsSignOut: boolean;
  /** If true, this is user-fixable; hide the "developers working on it" note */
  isKnown: boolean;
}

const PROFILES: Record<string, ErrorProfile> = {
  SESSION_EXPIRED: {
    icon:    'log-in-outline',
    color:   C.amber,
    bgColor: C.amberDim,
    title:   'Instagram session expired',
    body:    'Your Instagram login session expired — this happens every few weeks or when you log out of Instagram.',
    steps: [
      'Open StayReel Settings (bottom-right tab).',
      'Tap Reconnect Instagram.',
      'Log in all the way to your Instagram home feed inside the app.',
      'Tap "Connect this account" and you\'re set.',
    ],
    needsReconnect: true,
    needsSignOut:   false,
    isKnown:        true,
  },
  IG_SESSION_INVALID: {
    icon:    'log-in-outline',
    color:   C.amber,
    bgColor: C.amberDim,
    title:   'Instagram session invalid',
    body:    'StayReel could not authenticate with Instagram. Your session may have been revoked.',
    steps: [
      'Open StayReel Settings and tap Reconnect Instagram.',
      'Make sure you log in all the way — don\'t stop at the username/password screen.',
      'Complete any two-factor authentication prompt.',
      'Wait until you see your Instagram home feed, then tap Connect.',
    ],
    needsReconnect: true,
    needsSignOut:   false,
    isKnown:        true,
  },
  UNAUTHORIZED: {
    icon:    'person-circle-outline',
    color:   C.amber,
    bgColor: C.amberDim,
    title:   'Session expired — please sign in again',
    body:    'Your StayReel login session has expired. This is normal and happens occasionally. Simply sign out and sign back in to continue.',
    steps: [
      'Tap "Sign Out" below.',
      'Sign back in with your email.',
      'Run your snapshot again.',
    ],
    needsReconnect: false,
    needsSignOut:   true,
    isKnown:        true,
  },
  CHALLENGE_REQUIRED: {
    icon:    'shield-outline',
    color:   '#f5a623',
    bgColor: '#1a1008',
    title:   'Instagram needs you to verify',
    body:    'Instagram flagged unusual activity on your account and requires identity verification.',
    steps: [
      'Open the Instagram app on your phone.',
      'You should see an alert — tap it and complete the verification (email / SMS / photo).',
      'Once verified, return to StayReel → Settings → Reconnect Instagram.',
      'Log back in and tap Connect.',
    ],
    needsReconnect: true,
    needsSignOut:   false,
    isKnown:        true,
  },
  CHECKPOINT_REQUIRED: {
    icon:    'shield-outline',
    color:   '#f5a623',
    bgColor: '#1a1008',
    title:   'Instagram account checkpoint',
    body:    'Instagram has temporarily restricted access to your account and requires you to pass a checkpoint.',
    steps: [
      'Open the native Instagram app.',
      'Follow the checkpoint instructions (usually an email or phone verification).',
      'After completing it, wait 15–30 minutes.',
      'Then go to StayReel Settings → Reconnect Instagram.',
    ],
    needsReconnect: true,
    needsSignOut:   false,
    isKnown:        true,
  },
  IG_CHALLENGE_REQUIRED: {
    icon:    'shield-outline',
    color:   '#f5a623',
    bgColor: '#1a1008',
    title:   'Instagram verification required',
    body:    'Instagram is asking to confirm this is really you.',
    steps: [
      'Open the Instagram app and complete the security check.',
      'Go to StayReel Settings → Reconnect Instagram.',
      'Log in and connect your account again.',
    ],
    needsReconnect: true,
    needsSignOut:   false,
    isKnown:        true,
  },
  IG_RATE_LIMITED: {
    icon:    'time-outline',
    color:   C.teal,
    bgColor: C.tealDim,
    title:   'Instagram is throttling requests',
    body:    'Instagram temporarily slowed down access to your account data. This usually clears on its own.',
    steps: [
      'Wait at least 1–6 hours before trying again.',
      'Do not keep retrying — it makes the throttle last longer.',
      'Make sure you\'re within your 3-snapshot daily limit.',
    ],
    needsReconnect: false,
    needsSignOut:   false,
    isKnown:        true,
  },
  SUSPICIOUS_RESPONSE: {
    icon:    'warning-outline',
    color:   C.amber,
    bgColor: C.amberDim,
    title:   'Unexpected response from Instagram',
    body:    'Instagram returned unusual data. This sometimes happens when Instagram updates its app.',
    steps: [
      'Wait 30–60 minutes and try again.',
      'If it keeps happening, try reconnecting Instagram in Settings.',
    ],
    needsReconnect: false,
    needsSignOut:   false,
    isKnown:        true,
  },
};

const UNKNOWN_PROFILE: ErrorProfile = {
  icon:           'bug-outline',
  color:          C.red,
  bgColor:        C.redDim,
  title:          'Something went wrong',
  body:           'An unexpected error occurred during your snapshot. This isn\'t something you did — our team has been automatically notified.',
  steps:          [],
  needsReconnect: false,
  needsSignOut:   false,
  isKnown:        false,
};

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  error: Error | null;
  onDismiss?: () => void;
}

export function SnapshotErrorCard({ error, onDismiss }: Props) {
  const router     = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const setIgAccountId = useAuthStore((s) => s.setIgAccountId);
  if (!error) return null;

  const code    = error instanceof SnapshotError ? error.code : 'INTERNAL_ERROR';
  const profile = PROFILES[code] ?? UNKNOWN_PROFILE;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setIgAccountId(null);
  };

  return (
    <View style={[styles.card, { borderColor: profile.color + '44' }]}>

      {/* Header */}
      <View style={[styles.header, { backgroundColor: profile.bgColor }]}>
        <Ionicons name={profile.icon as any} size={18} color={profile.color} style={{ marginRight: 8 }} />
        <Text style={[styles.headerTitle, { color: profile.color }]}>{profile.title}</Text>
        {onDismiss && (
          <TouchableOpacity onPress={onDismiss} style={styles.dismissBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close" size={16} color={profile.color} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.body}>

        {/* Body copy */}
        <Text style={styles.bodyText}>{profile.body}</Text>

        {/* Self-debug steps */}
        {profile.steps.length > 0 && (
          <View style={styles.stepsBlock}>
            <Text style={styles.stepsTitle}>How to fix it:</Text>
            {profile.steps.map((step, i) => (
              <View key={i} style={styles.stepRow}>
                <View style={[styles.stepBadge, { backgroundColor: profile.bgColor }]}>
                  <Text style={[styles.stepNum, { color: profile.color }]}>{i + 1}</Text>
                </View>
                <Text style={styles.stepText}>{step}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Reconnect CTA */}
        {profile.needsReconnect && (
          <TouchableOpacity
            style={[styles.reconnectBtn, { backgroundColor: profile.color }]}
            onPress={() => router.push('/(tabs)/settings')}
            activeOpacity={0.85}
          >
            <Ionicons name="logo-instagram" size={15} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.reconnectText}>Go to Settings → Reconnect</Text>
          </TouchableOpacity>
        )}

        {/* Sign out CTA */}
        {profile.needsSignOut && (
          <TouchableOpacity
            style={[styles.reconnectBtn, { backgroundColor: profile.color }]}
            onPress={handleSignOut}
            activeOpacity={0.85}
          >
            <Ionicons name="log-out-outline" size={15} color="#fff" style={{ marginRight: 6 }} />
            <Text style={styles.reconnectText}>Sign Out</Text>
          </TouchableOpacity>
        )}

        {/* Developer-alert note for unknown errors */}
        {!profile.isKnown && (
          <View style={styles.devNote}>
            <Ionicons name="construct-outline" size={14} color={C.textMuted} style={{ marginRight: 6, marginTop: 1 }} />
            <Text style={styles.devNoteText}>
              Our developers are working on a fix. You'll be notified through an app update when it's resolved.
            </Text>
          </View>
        )}

        {/* Always: owner notified */}
        <View style={styles.alertedNote}>
          <Ionicons name="notifications-outline" size={13} color={C.textMuted} style={{ marginRight: 5, marginTop: 1 }} />
          <Text style={styles.alertedText}>
            The StayReel team has been automatically alerted about this error.
          </Text>
        </View>

        {/* Raw error code for reference */}
        <Text style={styles.errorCode}>
          Error code: {code}{error instanceof SnapshotError && error.message ? ` — ${error.message}` : ''}
        </Text>

      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  card: {
    backgroundColor: C.surface,
    borderRadius:    14,
    borderWidth:     1,
    marginBottom:    14,
    overflow:        'hidden',
  },
  header: {
    flexDirection:     'row',
    alignItems:        'center',
    paddingVertical:   10,
    paddingHorizontal: 14,
  },
  headerTitle: {
    flex:       1,
    fontSize:   14,
    fontWeight: '700',
  },
  dismissBtn: {
    marginLeft: 8,
  },
  body: {
    padding: 14,
  },
  bodyText: {
    color:      C.textSecondary,
    fontSize:   13,
    lineHeight: 20,
    marginBottom: 16,
  },
  stepsBlock: {
    marginBottom: 16,
  },
  stepsTitle: {
    color:        C.textPrimary,
    fontSize:     13,
    fontWeight:   '600',
    marginBottom: 10,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    marginBottom:  10,
    gap:           10,
  },
  stepBadge: {
    width:          24,
    height:         24,
    borderRadius:   12,
    alignItems:     'center',
    justifyContent: 'center',
    marginTop:      1,
    flexShrink:     0,
  },
  stepNum: {
    fontSize:   12,
    fontWeight: '700',
  },
  stepText: {
    flex:       1,
    color:      C.textSecondary,
    fontSize:   13,
    lineHeight: 20,
  },
  reconnectBtn: {
    flexDirection:     'row',
    alignItems:        'center',
    justifyContent:    'center',
    borderRadius:      10,
    paddingVertical:   11,
    paddingHorizontal: 16,
    marginBottom:      14,
  },
  reconnectText: {
    color:      '#fff',
    fontSize:   13,
    fontWeight: '700',
  },
  devNote: {
    flexDirection:   'row',
    alignItems:      'flex-start',
    backgroundColor: C.surfaceAlt,
    borderRadius:    8,
    padding:         10,
    marginBottom:    10,
  },
  devNoteText: {
    flex:       1,
    color:      C.textMuted,
    fontSize:   12,
    lineHeight: 18,
  },
  alertedNote: {
    flexDirection: 'row',
    alignItems:    'flex-start',
    marginBottom:  6,
  },
  alertedText: {
    flex:       1,
    color:      C.textMuted,
    fontSize:   12,
    lineHeight: 17,
  },
  errorCode: {
    color:     C.textMuted,
    fontSize:  10,
    marginTop: 4,
    opacity:   0.6,
  },
});
