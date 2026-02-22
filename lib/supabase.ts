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
// Call once at app start from the root layout.
export async function handleAuthDeepLink(url: string | null): Promise<void> {
  if (!url) return;

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
    await supabase.auth.exchangeCodeForSession(code);
    return;
  }

  // Legacy fragment hash token
  if (fragment) {
    await supabase.auth.setSession({
      access_token:  new URLSearchParams(fragment).get('access_token')  ?? '',
      refresh_token: new URLSearchParams(fragment).get('refresh_token') ?? '',
    });
  }
}
