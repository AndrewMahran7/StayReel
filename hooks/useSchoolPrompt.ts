// hooks/useSchoolPrompt.ts
// Decides whether the school-picker modal should appear for the current user.
//
// Shows the modal when ALL of:
//   1. User is authenticated and fully onboarded (has igAccountId).
//   2. Profile has school = NULL AND school_do_not_ask = FALSE.
//
// The query runs once per app launch (staleTime = Infinity) and is
// invalidated from the modal's onDone callback so it re-evaluates.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { useCallback } from 'react';
import { ENABLE_POST_CONNECT_ONBOARDING } from '@/lib/featureFlags';

const QUERY_KEY = 'school-prompt';

export function useSchoolPrompt() {
  const userId      = useAuthStore((s) => s.user?.id);
  const igAccountId = useAuthStore((s) => s.igAccountId);
  const qc          = useQueryClient();

  const query = useQuery({
    queryKey: [QUERY_KEY, userId],
    enabled:  ENABLE_POST_CONNECT_ONBOARDING && !!userId && !!igAccountId,
    staleTime: Infinity,          // only fetch once per session
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('school, school_do_not_ask')
        .eq('id', userId!)
        .maybeSingle();

      if (error || !data) return false;

      // Show if school not yet set AND user hasn't dismissed
      return !data.school && !data.school_do_not_ask;
    },
  });

  const dismiss = useCallback(() => {
    // Optimistically hide the modal and refetch from DB
    qc.setQueryData([QUERY_KEY, userId], false);
    qc.invalidateQueries({ queryKey: [QUERY_KEY, userId] });
  }, [qc, userId]);

  return {
    shouldShow: ENABLE_POST_CONNECT_ONBOARDING && query.data === true,
    dismiss,
  };
}
