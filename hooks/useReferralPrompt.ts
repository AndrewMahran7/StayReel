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

    // Defensive: parse JSON safely — gateway 502 may return HTML
    let json: Record<string, unknown> | null = null;
    try {
      json = await res.json();
    } catch {
      // Non-JSON response body
    }

    if (json?.success === true) {
      setReferralAttribute(code.trim().toLowerCase());
      return true;
    }
    return false;
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

  // Session-level guard: once dismissed, never show again this session.
  // Prevents the show→hide→show loop if the query refetches with stale DB state.
  const dismissedRef = useRef(false);
  const mountCount   = useRef(0);
  mountCount.current += 1;

  // Check DB state: should we show the modal?
  const query = useQuery({
    queryKey: [QUERY_KEY, userId],
    enabled:  !!userId && !!igAccountId,
    staleTime: Infinity,
    queryFn: async (): Promise<boolean> => {
      // Respect the session-level dismiss flag
      if (dismissedRef.current) {
        console.log('[Referral:prompt] queryFn skipped — dismissed this session');
        return false;
      }

      const { data, error } = await supabase
        .from('profiles')
        .select('referred_by, referral_source')
        .eq('id', userId!)
        .maybeSingle();

      console.log('[Referral:prompt] queryFn result:', {
        referred_by: data?.referred_by ?? null,
        referral_source: data?.referral_source ?? null,
        error: error?.message ?? null,
      });

      if (error || !data) return false;

      // Already attributed — no prompt
      if (data.referred_by) return false;

      // User explicitly skipped — no prompt
      if (data.referral_source === '__skipped__') return false;

      return true;
    },
  });

  const shouldShow = !dismissedRef.current && query.data === true;

  // Debug logging — fires on every render but is cheap
  console.log('[Referral:prompt]', {
    shouldShow,
    dismissedThisSession: dismissedRef.current,
    queryData: query.data,
    mountRender: mountCount.current,
    userId: userId ?? 'none',
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
        dismissedRef.current = true;
        qc.setQueryData([QUERY_KEY, userId], false);
        console.log('[Referral] Stashed code applied successfully');
      }
    })();
  }, [userId, igAccountId]);

  // dismiss: hide the modal for the rest of this app session.
  // Invalidates the Settings profile-referral query so it re-fetches
  // and shows the manual entry row immediately after skip.
  const dismiss = useCallback(() => {
    console.log('[Referral:prompt] dismiss() called');
    dismissedRef.current = true;
    qc.setQueryData([QUERY_KEY, userId], false);
    // Force the Settings referral query to re-fetch so it picks up the
    // new referral_source value (e.g. '__skipped__') without waiting 60 s.
    qc.invalidateQueries({ queryKey: ['profile-referral', userId] });
  }, [qc, userId]);

  return {
    shouldShow,
    dismiss,
  };
}
