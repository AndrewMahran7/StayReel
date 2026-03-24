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
    flowType: 'pkce',
  },
});

// Handle deep-link callbacks (magic link, OAuth redirect).
// Called from the root layout bootstrap (cold start) and the warm-start
// Linking event listener.  Returns true when a session was established.
export async function handleAuthDeepLink(url: string | null): Promise<boolean> {
  if (!url) return false;

  console.log('[Auth] Processing deep link:', url);

  // Supabase puts the token_hash in the query string (PKCE flow) or the
  // URL fragment (#access_token=...&refresh_token=...) for the legacy flow.
  // expo-linking's ParsedURL intentionally omits the fragment, so we
  // extract it manually.
  const { queryParams } = Linking.parse(url);
  const hashIdx  = url.indexOf('#');
  const fragment = hashIdx >= 0 ? url.slice(hashIdx + 1) : null;

  // PKCE flow: code in query params
  const code = (queryParams?.code as string) ?? null;
  if (code) {
    console.log('[Auth] Exchanging PKCE code for session…');
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.warn('[Auth] Code exchange failed:', error.message);
      return false;
    }
    console.log('[Auth] Code exchange succeeded');
    return true;
  }

  // Legacy fragment hash token
  if (fragment) {
    console.log('[Auth] Setting session from URL fragment…');
    const { error } = await supabase.auth.setSession({
      access_token:  new URLSearchParams(fragment).get('access_token')  ?? '',
      refresh_token: new URLSearchParams(fragment).get('refresh_token') ?? '',
    });
    if (error) {
      console.warn('[Auth] Fragment session failed:', error.message);
      return false;
    }
    return true;
  }

  return false;
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
