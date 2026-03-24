// hooks/useNotificationSettings.ts
// Read + write notification preferences from the user_settings table.
//
// Uses TanStack Query for caching + invalidation.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

// ── Types ──────────────────────────────────────────────────────

export interface NotificationPrefs {
  notify_refresh_complete: boolean;
  notify_weekly_summary:   boolean;
  notify_on_unfollow:      boolean;
  notify_on_token_expiry:  boolean;
}

const DEFAULTS: NotificationPrefs = {
  notify_refresh_complete: true,
  notify_weekly_summary:   true,
  notify_on_unfollow:      true,
  notify_on_token_expiry:  true,
};

const QUERY_KEY = 'notification-settings';

// ── Hook ───────────────────────────────────────────────────────

export function useNotificationSettings() {
  const userId = useAuthStore((s) => s.user?.id);
  const qc     = useQueryClient();

  const query = useQuery({
    queryKey: [QUERY_KEY, userId],
    enabled:  !!userId,
    staleTime: 60_000,              // 1 min — settings rarely change
    queryFn: async (): Promise<NotificationPrefs> => {
      const { data, error } = await supabase
        .from('user_settings')
        .select(
          'notify_refresh_complete, notify_weekly_summary, notify_on_unfollow, notify_on_token_expiry',
        )
        .eq('user_id', userId!)
        .maybeSingle();

      if (error) throw error;
      if (!data) return DEFAULTS;

      return {
        notify_refresh_complete: data.notify_refresh_complete ?? DEFAULTS.notify_refresh_complete,
        notify_weekly_summary:   data.notify_weekly_summary   ?? DEFAULTS.notify_weekly_summary,
        notify_on_unfollow:      data.notify_on_unfollow      ?? DEFAULTS.notify_on_unfollow,
        notify_on_token_expiry:  data.notify_on_token_expiry  ?? DEFAULTS.notify_on_token_expiry,
      };
    },
  });

  const mutation = useMutation({
    mutationFn: async (patch: Partial<NotificationPrefs>) => {
      const { error } = await supabase
        .from('user_settings')
        .upsert(
          { user_id: userId!, ...patch, updated_at: new Date().toISOString() },
          { onConflict: 'user_id' },
        );
      if (error) throw error;
    },
    // Optimistic update so toggles feel instant
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: [QUERY_KEY, userId] });
      const prev = qc.getQueryData<NotificationPrefs>([QUERY_KEY, userId]);
      qc.setQueryData<NotificationPrefs>([QUERY_KEY, userId], (old) => ({
        ...(old ?? DEFAULTS),
        ...patch,
      }));
      return { prev };
    },
    onError: (_err, _patch, context) => {
      // Revert on failure
      if (context?.prev) qc.setQueryData([QUERY_KEY, userId], context.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY, userId] });
    },
  });

  return {
    settings:   query.data ?? DEFAULTS,
    isLoading:  query.isLoading,
    update:     mutation.mutateAsync,
    isUpdating: mutation.isPending,
  };
}
