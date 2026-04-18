// lib/supabase.ts
// Supabase client configured with:
//   • AsyncStorage session persistence
//   • Deep-link URL handler for magic-link auth callbacks

import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';

const SUPABASE_URL  = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,   // handled manually below
    // Use implicit flow for mobile magic links. PKCE requires the same
    // process that called signInWithOtp() to also receive the callback
    // (it stores a code_verifier in AsyncStorage). On iOS the magic link
    // opens Safari first → Supabase server → redirect back to the app,
    // which is a different context. If iOS killed the app in between, or
    // the user requested a second link, the verifier is gone and the
    // exchange fails with "PKCE code verifier not found in storage".
    // Implicit flow sends token_hash + type params instead, which are
    // self-contained and don't need stored state.
    flowType: 'implicit',
  },
});

// ── Deep-link helpers ───────────────────────────────────────────────
// Track the last code/token we attempted so duplicate exchange calls
// (root layout + auth.tsx) don't race and burn the single-use token.
let _lastExchangedCode: string | null = null;
let _lastVerifiedHash:  string | null = null;

// Handle deep-link callbacks (magic link, OAuth redirect).
// Called from the root layout bootstrap (cold start) and the warm-start
// Linking event listener.  Returns true when a session was established.
export async function handleAuthDeepLink(url: string | null): Promise<boolean> {
  if (!url) return false;

  console.log('[Auth] Processing deep link:', url);

  // expo-linking's ParsedURL intentionally omits the fragment, so we
  // extract it manually.
  const { queryParams } = Linking.parse(url);
  const hashIdx  = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;

  // ── Error from Supabase redirect (e.g. expired token) ──────────
  const errorParam = queryParams?.error as string | undefined;
  if (errorParam) {
    const desc = (queryParams?.error_description as string) ?? errorParam;
    console.warn('[Auth] Deep link error from provider:', desc);
    return false;
  }

  // ── Token-hash flow (implicit / magic-link) ───────────────────
  // Implicit flow sends token_hash + type as query params. This is the
  // primary path for mobile magic-link auth.
  const tokenHash = queryParams?.token_hash as string | undefined;
  const type      = queryParams?.type as string | undefined;
  if (tokenHash && type) {
    if (tokenHash === _lastVerifiedHash) {
      console.log('[Auth] token_hash already verified, skipping duplicate');
      return false;
    }
    _lastVerifiedHash = tokenHash;
    console.log('[Auth] Verifying OTP via token_hash (type:', type, ')…');
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as 'magiclink' | 'signup' | 'invite' | 'recovery' | 'email',
    });
    if (error) {
      console.warn('[Auth] verifyOtp failed:', error.message);
      _lastVerifiedHash = null; // allow retry
      return false;
    }
    console.log('[Auth] verifyOtp succeeded');
    return true;
  }

  // ── PKCE fallback: code in query params ────────────────────────
  // Kept for backwards compatibility if any existing emails in users'
  // inboxes still carry a PKCE code from before the flow change.
  const code = (queryParams?.code as string) ?? null;
  if (code) {
    if (code === _lastExchangedCode) {
      console.log('[Auth] Code already exchanged, skipping duplicate');
      return false;
    }
    _lastExchangedCode = code;
    console.log('[Auth] Exchanging PKCE code for session (legacy)…');
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn('[Auth] Code exchange failed:', error.message);
      _lastExchangedCode = null; // allow retry
      return false;
    }
    console.log('[Auth] Code exchange succeeded');
    return true;
  }

  // ── Legacy fragment hash token (#access_token=…&refresh_token=…) ─
  if (fragment) {
    const fragParams   = new URLSearchParams(fragment);
    const accessToken  = fragParams.get('access_token');
    const refreshToken = fragParams.get('refresh_token');
    if (accessToken && refreshToken) {
      console.log('[Auth] Setting session from URL fragment…');
      const { error } = await supabase.auth.setSession({
        access_token:  accessToken,
        refresh_token: refreshToken,
      });
      if (error) {
        console.warn('[Auth] Fragment session failed:', error.message);
        return false;
      }
      return true;
    }
  }

  console.log('[Auth] Deep link contained no auth params — ignoring');
  return false;
}

/**
 * Standalone PKCE code exchange — called directly from auth.tsx as a
 * fallback when the root-layout handler misses the URL or loses the race.
 * Returns a rich result so the UI can display a meaningful error.
 */
export async function exchangeAuthCode(
  code: string,
  force = false,
): Promise<{ success: boolean; error?: string }> {
  if (!force && code === _lastExchangedCode) {
    console.log('[Auth] exchangeAuthCode: code already processed');
    return { success: false, error: 'Code already processed' };
  }
  _lastExchangedCode = code;
  try {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn('[Auth] exchangeAuthCode failed:', error.message);
      _lastExchangedCode = null; // allow retry
      return { success: false, error: error.message };
    }
    console.log('[Auth] exchangeAuthCode succeeded');
    return { success: true };
  } catch (e: any) {
    _lastExchangedCode = null;
    return { success: false, error: e?.message ?? 'Unknown error during code exchange' };
  }
}

// ── Suppress noisy auto-refresh errors ──────────────────────────────
// Supabase's internal `autoRefreshToken` timer may fire after a sign-out
// or with a consumed refresh token, producing an "Invalid Refresh Token"
// rejection.  We listen for it here so it doesn't bubble as an unhandled
// promise rejection / LogBox warning.
supabase.auth.onAuthStateChange((event, _session) => {
  // Nothing to do — we just need the listener registered so supabase-js
  // considers the event "handled".  Actual routing is in _layout.tsx.
});
