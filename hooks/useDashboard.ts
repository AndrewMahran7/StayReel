// hooks/useDashboard.ts
// Fetches the latest diff summary for the connected IG account.
// Persists the latest result locally so it can be shown when offline.

import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';
import { saveSnapshot, loadSnapshot } from '@/lib/offlineStorage';
import { fetchWithTimeout } from '@/lib/fetchWithTimeout';

export interface DiffSummary {
  // Diff identification
  diff_id:                    string | null;
  from_captured_at:           string | null;
  to_captured_at:             string;

  // Change metrics
  new_followers_count:        number;
  lost_followers_count:       number;
  you_unfollowed_count:       number;
  you_newly_followed_count:   number;
  not_following_back_count:   number;
  you_dont_follow_back_count: number;
  net_follower_change:        number;
  net_following_change:       number;

  // Account stats (from latest snapshot)
  follower_count:             number;
  following_count:            number;
  mutual_count:               number;

  // Weekly summary
  weekly_new_followers:       number;
  weekly_lost_followers:      number;
  weekly_net_change:          number;
  has_weekly_summary:         boolean;

  // Streak
  current_streak_days:        number;
  longest_streak_days:        number;

  // Rate limit
  next_snapshot_allowed_at:   string | null;
  cooldown_reason:            'hourly' | 'daily_cap' | null;
  snapshots_today:            number;

  // Flags
  is_complete:                boolean;
  has_diff:                   boolean;
}

async function fetchDashboard(igAccountId: string): Promise<DiffSummary | null> {
  // getSession() reads from cache and can return an expired token when the
  // OS killed the background refresh timer. Refresh proactively if needed.
  let { data: { session } } = await supabase.auth.getSession();
  const expiresAt = session?.expires_at ?? 0;
  if (!session?.access_token || (expiresAt * 1_000 - Date.now()) < 60_000) {
    const { data } = await supabase.auth.refreshSession();
    session = data.session;
  }

  const res = await fetchWithTimeout(
    `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/diffs-latest?ig_account_id=${igAccountId}`,
    {
      headers: {
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      },
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json?.to_captured_at) return null;
  return json as DiffSummary;
}

export function useDashboard() {
  const igAccountId = useAuthStore((s) => s.igAccountId);
  const qc = useQueryClient();
  const seeded = useRef(false);

  // On mount, seed the query cache from local storage so the user sees
  // data instantly (before any network call).  Runs once per mount.
  useEffect(() => {
    if (!igAccountId || seeded.current) return;
    seeded.current = true;

    loadSnapshot().then((stored) => {
      if (!stored) return;
      // Only seed if the cache is currently empty (i.e. first load).
      const existing = qc.getQueryData(['dashboard', igAccountId]);
      if (!existing) {
        qc.setQueryData(['dashboard', igAccountId], stored.data);
      }
    });
  }, [igAccountId]);

  const query = useQuery<DiffSummary | null, Error>({
    queryKey:  ['dashboard', igAccountId],
    queryFn:   () => fetchDashboard(igAccountId!),
    enabled:   !!igAccountId,
    staleTime: 60_000,
  });

  // Persist every successful fetch to local storage.
  const lastSaved = useRef<string | null>(null);
  useEffect(() => {
    if (query.data && query.data.to_captured_at !== lastSaved.current) {
      lastSaved.current = query.data.to_captured_at;
      saveSnapshot(query.data);
    }
  }, [query.data]);

  return query;
}

