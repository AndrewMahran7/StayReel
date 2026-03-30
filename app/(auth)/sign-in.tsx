// app/(auth)/sign-in.tsx
// Magic-link sign-in. Supabase sends an email; tapping the link
// deep-links back into the app and the root layout handles the session.

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Linking from 'expo-linking';
import { supabase } from '@/lib/supabase';
import C from '@/lib/colors';

export default function SignInScreen() {
  const [email,       setEmail]       = useState('');
  const [password,    setPassword]    = useState('');
  const [loading,     setLoading]     = useState(false);
  const [sent,        setSent]        = useState(false);

  const DEV_EMAIL    = process.env.EXPO_PUBLIC_DEV_EMAIL;
  const DEV_PASSWORD = process.env.EXPO_PUBLIC_DEV_PASSWORD;
  const showDevBypass = __DEV__ && !!DEV_EMAIL && !!DEV_PASSWORD;

  // True when the typed email matches the backdoor address
  const isDevEmail = !!DEV_EMAIL && email.trim().toLowerCase() === DEV_EMAIL.toLowerCase();

  const handleDevLogin = async () => {
    setLoading(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email:    DEV_EMAIL!,
        password: DEV_PASSWORD!,
      });
      if (error) Alert.alert('Dev login failed', error.message);
    } catch (e: any) {
      Alert.alert('Sign-in error', e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes('@')) {
      Alert.alert('Invalid email', 'Please enter a valid email address.');
      return;
    }

    // ── App Store review backdoor ──────────────────────────────
    // If the reviewer enters the designated test email, require the
    // matching password before signing in (no magic link sent).
    if (DEV_EMAIL && DEV_PASSWORD && trimmed === DEV_EMAIL.toLowerCase()) {
      if (!password) {
        // Password field is now visible — just focus it, don't submit yet.
        return;
      }
      setLoading(true);
      try {
        const { error } = await supabase.auth.signInWithPassword({
          email:    DEV_EMAIL,
          password: password,
        });
        if (error) Alert.alert('Sign in failed', error.message);
      } catch (e: any) {
        Alert.alert('Sign-in error', e?.message ?? 'Something went wrong. Please try again.');
      } finally {
        setLoading(false);
      }
      return;
    }
    // ──────────────────────────────────────────────────────────

    setLoading(true);
    try {
      // Linking.createURL returns exp://host/--/auth in Expo Go
      // and stayreel://auth in a native build.
      const redirectTo = Linking.createURL('auth');
      const { error } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: redirectTo },
      });

      if (error) {
        Alert.alert('Error', error.message);
        return;
      }
      setSent(true);
    } catch (e: any) {
      Alert.alert('Error', e?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Logo / branding */}
          <View style={styles.logoWrap}>
            <Ionicons name="eye" size={48} color={C.accent} />
            <Text style={styles.appName}>StayReel</Text>
            <Text style={styles.tagline}>Know who stays — and who doesn&apos;t.</Text>
          </View>

          {sent ? (
            // Post-send confirmation
            <View style={styles.sentCard}>
              <Ionicons name="mail-open-outline" size={36} color={C.green} />
              <Text style={styles.sentTitle}>Check your inbox</Text>
              <Text style={styles.sentBody}>
                We sent a sign-in link to{' '}
                <Text style={styles.bold}>{email.trim()}</Text>.
                {'\n\n'}
                Tap the link in the email to continue. You can close this screen.
              </Text>
              <TouchableOpacity onPress={() => setSent(false)} style={styles.resend}>
                <Text style={styles.resendText}>Use a different email →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            // Email input
            <View style={styles.form}>
              <Text style={styles.label}>Email address</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={(v) => { setEmail(v); setPassword(''); }}
                placeholder="you@example.com"
                placeholderTextColor={C.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType={isDevEmail ? 'next' : 'send'}
                onSubmitEditing={isDevEmail ? undefined : handleSend}
              />

              {/* Password field — only shown for the backdoor email */}
              {isDevEmail && (
                <>
                  <Text style={styles.label}>Password</Text>
                  <TextInput
                    style={styles.input}
                    value={password}
                    onChangeText={setPassword}
                    placeholder="Enter password"
                    placeholderTextColor={C.textMuted}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={handleSend}
                  />
                </>
              )}

              <TouchableOpacity
                style={[styles.btn, (loading || (isDevEmail && !password)) && styles.btnDisabled]}
                onPress={handleSend}
                disabled={loading || (isDevEmail && !password)}
              >
                {loading
                  ? <ActivityIndicator color="#fff" />
                  : <Text style={styles.btnText}>{isDevEmail ? 'Sign in' : 'Send magic link'}</Text>
                }
              </TouchableOpacity>

              <Text style={styles.note}>
                No password needed. We&apos;ll email you a one-tap sign-in link.
              </Text>

              {showDevBypass && (
                <TouchableOpacity
                  style={styles.devBtn}
                  onPress={handleDevLogin}
                  disabled={loading}
                >
                  <Text style={styles.devBtnText}>⚙️ Dev bypass (skip email)</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex:            1,
    backgroundColor: C.black,
  },
  container: {
    flexGrow:       1,
    justifyContent: 'center',
    padding:        24,
    gap:            32,
  },
  logoWrap: {
    alignItems: 'center',
    gap:         8,
  },
  appName: {
    color:      C.textPrimary,
    fontSize:   34,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  tagline: {
    color:    C.textSecondary,
    fontSize: 15,
  },
  form: {
    gap: 14,
  },
  label: {
    color:      C.textSecondary,
    fontSize:   13,
    fontWeight: '600',
    marginBottom: -6,
  },
  input: {
    backgroundColor:  C.surfaceAlt,
    borderRadius:     12,
    paddingHorizontal: 16,
    paddingVertical:   14,
    color:            C.textPrimary,
    fontSize:         16,
    borderWidth:      1,
    borderColor:      C.border,
  },
  btn: {
    backgroundColor: C.accent,
    borderRadius:    14,
    height:          52,
    alignItems:      'center',
    justifyContent:  'center',
    marginTop:       4,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: {
    color:      '#fff',
    fontSize:   16,
    fontWeight: '700',
  },
  note: {
    color:      C.textMuted,
    fontSize:   12,
    textAlign:  'center',
    lineHeight: 18,
  },
  sentCard: {
    backgroundColor: C.surface,
    borderRadius:    16,
    padding:         24,
    alignItems:      'center',
    gap:             12,
  },
  sentTitle: {
    color:      C.textPrimary,
    fontSize:   20,
    fontWeight: '700',
  },
  sentBody: {
    color:      C.textSecondary,
    fontSize:   14,
    textAlign:  'center',
    lineHeight: 22,
  },
  bold: {
    color:      C.textPrimary,
    fontWeight: '600',
  },
  resend: { marginTop: 8 },
  resendText: {
    color:    C.accent,
    fontSize: 14,
  },
  devBtn: {
    borderWidth:  1,
    borderColor:  '#444',
    borderRadius: 14,
    height:       44,
    alignItems:   'center',
    justifyContent: 'center',
    marginTop:    8,
  },
  devBtnText: {
    color:    '#888',
    fontSize: 13,
  },
});
