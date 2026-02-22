// hooks/useSnapshotHistory.ts
// Fetches historical snapshot data for the growth chart.

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

export interface SnapshotPoint {
  captured_at:    string;
  follower_count:  number;
  following_count: number;
  mutual_count:    number | null;
}

async function fetchHistory(igAccountId: string, days: number): Promise<SnapshotPoint[]> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/snapshot-history?ig_account_id=${igAccountId}&days=${days}`,
    {
      headers: {
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      },
    },
  );
  if (!res.ok) return [];
  const json = await res.json();
  return (json?.snapshots ?? []) as SnapshotPoint[];
}

export function useSnapshotHistory(days: 7 | 30 = 7) {
  const igAccountId = useAuthStore((s) => s.igAccountId);

  return useQuery<SnapshotPoint[], Error>({
    queryKey:  ['snapshot-history', igAccountId, days],
    queryFn:   () => fetchHistory(igAccountId!, days),
    enabled:   !!igAccountId,
    staleTime: 5 * 60_000,
  });
}
