// hooks/useReferralPrompt.ts
// Decides whether the referral-code modal should appear for the current user.
//
// Shows the modal when ALL of:
//   1. User is authenticated and fully onboarded (has igAccountId).
//   2. profiles.referred_by IS NULL  (not yet attributed).
//   3. profiles.referral_source IS NOT '__skipped__'  (didn't dismiss).
//
// Also handles the AsyncStorage pre-signup referral code — if one exists,
// auto-applies it via set-referral at bootstrap instead of showing the modal.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { setReferralAttribute } from '@/lib/revenueCat';
import { useCallback, useEffect, useRef } from 'react';

const QUERY_KEY     = 'referral-prompt';
const STORAGE_KEY   = '@stayreel:referral_code';

/**
 * Save a referral code to AsyncStorage before the user has signed up.
 * Called from a future deep-link handler or pre-auth entry point.
 */
export async function stashReferralCode(code: string): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, code.trim().toLowerCase());
}

/**
 * Read and clear any stashed referral code from AsyncStorage.
 */
export async function consumeStashedCode(): Promise<string | null> {
  const code = await AsyncStorage.getItem(STORAGE_KEY);
  if (code) await AsyncStorage.removeItem(STORAGE_KEY);
  return code;
}

/**
 * Apply a referral code via the set-referral edge function.
 * Returns true if attribution succeeded.
 */
async function applyCode(code: string): Promise<boolean> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return false;

    const res = await fetch(
      `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/set-referral`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
        },
        body: JSON.stringify({ code: code.trim().toLowerCase() }),
      },
    );
    const json = await res.json();
    if (json.attributed) {
      setReferralAttribute(code.trim().toLowerCase());
    }
    return json.attributed === true;
  } catch (err) {
    console.warn('[Referral] applyCode error:', err);
    return false;
  }
}

export function useReferralPrompt() {
  const userId      = useAuthStore((s) => s.user?.id);
  const igAccountId = useAuthStore((s) => s.igAccountId);
  const qc          = useQueryClient();
  const autoApplied = useRef(false);

  // Check DB state: should we show the modal?
  const query = useQuery({
    queryKey: [QUERY_KEY, userId],
    enabled:  !!userId && !!igAccountId,
    staleTime: Infinity,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('referred_by, referral_source')
        .eq('id', userId!)
        .maybeSingle();

      if (error || !data) return false;

      // Already attributed — no prompt
      if (data.referred_by) return false;

      // User explicitly skipped — no prompt
      if (data.referral_source === '__skipped__') return false;

      return true;
    },
  });

  // Auto-apply stashed code from AsyncStorage (pre-signup flow)
  useEffect(() => {
    if (!userId || !igAccountId || autoApplied.current) return;
    autoApplied.current = true;

    (async () => {
      const stashed = await consumeStashedCode();
      if (!stashed) return;

      console.log('[Referral] Auto-applying stashed code:', stashed);
      const ok = await applyCode(stashed);
      if (ok) {
        // Attribution succeeded — suppress the modal
        qc.setQueryData([QUERY_KEY, userId], false);
        qc.invalidateQueries({ queryKey: [QUERY_KEY, userId] });
        console.log('[Referral] Stashed code applied successfully');
      }
    })();
  }, [userId, igAccountId]);

  const dismiss = useCallback(() => {
    qc.setQueryData([QUERY_KEY, userId], false);
    qc.invalidateQueries({ queryKey: [QUERY_KEY, userId] });
  }, [qc, userId]);

  return {
    shouldShow: query.data === true,
    dismiss,
  };
}
