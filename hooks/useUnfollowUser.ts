// hooks/useUnfollowUser.ts
// Mutation to unfollow a user on Instagram via the unfollow-user Edge Function.
// Tracks locally-unfollowed ig_ids so the UI can reflect the action immediately.

import { useState, useCallback } from 'react';
import { useMutation }           from '@tanstack/react-query';
import { supabase }              from '@/lib/supabase';
import { fetchWithTimeout }      from '@/lib/fetchWithTimeout';

interface UnfollowVars {
  igAccountId: string;
  targetIgId:  string;
}

async function callUnfollow(vars: UnfollowVars): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();

  const res = await fetchWithTimeout(
    `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/unfollow-user`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization:   `Bearer ${session?.access_token ?? ''}`,
        apikey:          process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({
        ig_account_id: vars.igAccountId,
        target_ig_id:  vars.targetIgId,
      }),
    },
  );

  if (!res.ok) {
    let msg = `Unfollow failed (${res.status})`;
    try {
      const json = await res.json();
      if (json?.message) msg = json.message;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
}

export function useUnfollowUser() {
  // Track successfully-unfollowed ig_ids locally so button stays "Done" without
  // needing to refetch the list.
  const [unfollowed, setUnfollowed] = useState<Set<string>>(new Set());

  const mutation = useMutation<void, Error, UnfollowVars>({
    mutationFn: callUnfollow,
    onSuccess: (_data, vars) => {
      setUnfollowed((prev) => {
        const next = new Set(prev);
        next.add(vars.targetIgId);
        return next;
      });
    },
  });

  const unfollow = useCallback(
    (igAccountId: string, targetIgId: string) => {
      // Ignore if already done or in-flight for this id
      if (unfollowed.has(targetIgId)) return;
      mutation.mutate({ igAccountId, targetIgId });
    },
    [mutation, unfollowed],
  );

  return {
    unfollow,
    unfollowed,
    isPending: mutation.isPending,
    pendingId: mutation.isPending ? mutation.variables?.targetIgId : null,
    error:     mutation.error,
  };
}
