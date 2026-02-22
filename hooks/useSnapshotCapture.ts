// hooks/useSnapshotCapture.ts
// Triggers the capture-snapshot Edge Function and invalidates queries.
// Exposes nextAllowedAt when a SNAPSHOT_LIMIT error is returned.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuthStore } from '@/store/authStore';

export interface CaptureResult {
  snapshot_id:      string;
  diff_id:          string | null;
  follower_count:   number;
  following_count:  number;
  captured_at:      string;
  is_list_complete: boolean;
}

export class SnapshotLimitError extends Error {
  constructor(
    public readonly nextAllowedAt: string,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotLimitError';
  }
}

async function triggerCapture(igAccountId: string): Promise<CaptureResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(
    `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/capture-snapshot`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization:  `Bearer ${session?.access_token ?? ''}`,
        apikey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify({ ig_account_id: igAccountId, source: 'manual' }),
    },
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Structured limit error — expose nextAllowedAt so the UI can show a countdown
    if (body?.error === 'SNAPSHOT_LIMIT' && body?.detail?.next_allowed_at) {
      throw new SnapshotLimitError(body.detail.next_allowed_at, body.message ?? 'Daily limit reached.');
    }
    throw new Error(body?.message ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<CaptureResult>;
}

export function useSnapshotCapture() {
  const qc          = useQueryClient();
  const igAccountId = useAuthStore((s) => s.igAccountId);

  return useMutation<CaptureResult, Error>({
    mutationFn: () => triggerCapture(igAccountId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['snapshot-history'] });
    },
  });
}

