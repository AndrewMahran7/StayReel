// hooks/useListData.ts
// Paginated query for any of the five user lists.
// Delegates to the list-users Edge Function so set-diff logic runs
// server-side with adminClient (no RLS / key-mismatch issues).

import { useInfiniteQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

export type ListType =
  | 'new_followers'
  | 'lost_followers'
  | 'not_following_back'
  | 'you_dont_follow_back'
  | 'you_unfollowed';

export interface IgUser {
  ig_id:    string;
  username: string;
}

interface FetchListPage {
  items:    IgUser[];
  nextPage: number | null;
  total:    number;
  isLimited: boolean;
}

async function fetchListPage(
  igAccountId: string,
  listType: ListType,
  page: number,
  search: string,
): Promise<FetchListPage> {
  const { data: { session } } = await supabase.auth.getSession();

  const params = new URLSearchParams({
    ig_account_id: igAccountId,
    list_type:     listType,
    page:          String(page),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const res = await fetch(
    `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/list-users?${params}`,
    {
      headers: {
        Authorization: `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      },
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.message ?? `HTTP ${res.status}`);
  }

  const json = await res.json();

  // ── Gating diagnostic (always logged — visible in Metro & release logs) ──
  console.log('[useListData] response:', {
    listType,
    page,
    itemCount:  (json.items ?? []).length,
    total:      json.total,
    is_limited: json.is_limited,
  });

  return {
    items:     json.items      ?? [],
    nextPage:  json.next_page  ?? null,
    total:     json.total      ?? 0,
    isLimited: json.is_limited ?? false,
  };
}

export function useListData(listType: ListType, search: string) {
  const igAccountId = useAuthStore((s) => s.igAccountId);

  return useInfiniteQuery<FetchListPage, Error>({
    queryKey:       ['list', listType, search, igAccountId],
    initialPageParam: 0,
    queryFn:        ({ pageParam }: { pageParam: unknown }) =>
      fetchListPage(igAccountId!, listType, (pageParam as number) ?? 0, search),
    getNextPageParam: (last: FetchListPage) => last.nextPage,
    enabled:        !!igAccountId,
  });
}
