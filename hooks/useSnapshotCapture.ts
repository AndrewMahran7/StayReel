// hooks/useSnapshotCapture.ts
// Triggers the resumable snapshot job system (snapshot-start → poll snapshot-continue).
// Exposes live progress so the UI can show a progress bar.
// Exposes nextAllowedAt when a SNAPSHOT_LIMIT error is returned.

import { useState, useRef, useCallback } from 'react';
import { useQueryClient }                from '@tanstack/react-query';
import { supabase }                      from '@/lib/supabase';
import { useAuthStore }                  from '@/store/authStore';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CaptureResult {
  snapshot_id?:     string;
  diff_id?:         string | null;
  follower_count?:  number;
  following_count?: number;
  captured_at?:     string;
  is_list_complete?: boolean;
  // job fields (returned from new system)
  jobId?:           string;
  status?:          string;
}

export interface JobProgress {
  phase:          'followers' | 'following' | 'finalize' | null;
  pagesDone:      number;
  followersSeen:  number;
  followingSeen:  number;
  followingCached: boolean;
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

/** Thrown when the server returns a typed error code during a snapshot job. */
export class SnapshotError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

const BASE = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

async function authHeaders(): Promise<HeadersInit> {
  const { data: { session } } = await supabase.auth.getSession();
  return {
    'Content-Type': 'application/json',
    Authorization:  `Bearer ${session?.access_token ?? ''}`,
    apikey:         ANON,
  };
}

interface ChunkResponse {
  jobId:         string;
  status:        'running' | 'complete' | 'failed';
  phase:         'followers' | 'following' | 'finalize';
  pagesDone:     number;
  followersSeen: number;
  followingSeen: number;
  done:          boolean;
  followingCached?: boolean;
  error?:        string;
  message?:      string;
}

async function startJob(igAccountId: string): Promise<ChunkResponse> {
  const res = await fetch(`${BASE}/functions/v1/snapshot-start`, {
    method:  'POST',
    headers: await authHeaders(),
    body:    JSON.stringify({ ig_account_id: igAccountId, source: 'manual' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.error === 'SNAPSHOT_LIMIT' && body?.detail?.next_allowed_at) {
      throw new SnapshotLimitError(body.detail.next_allowed_at, body.message ?? 'You can take one snapshot per hour.');
    }
    // 401 can come from Supabase gateway ({"msg":"Invalid JWT"}) or our own requireAuth
    if (res.status === 401 || body?.error === 'UNAUTHORIZED') {
      throw new SnapshotError('UNAUTHORIZED', 'Session expired. Please sign out and sign back in.');
    }
    throw new SnapshotError(body?.error ?? 'UNKNOWN', body?.message ?? `HTTP ${res.status}`);
  }
  return body as ChunkResponse;
}

async function continueJob(jobId: string): Promise<ChunkResponse> {
  const res = await fetch(`${BASE}/functions/v1/snapshot-continue`, {
    method:  'POST',
    headers: await authHeaders(),
    body:    JSON.stringify({ job_id: jobId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || body?.error === 'UNAUTHORIZED') {
      throw new SnapshotError('UNAUTHORIZED', 'Session expired. Please sign out and sign back in.');
    }
    throw new SnapshotError(body?.error ?? 'UNKNOWN', body?.message ?? `HTTP ${res.status}`);
  }
  return body as ChunkResponse;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 1_000;
const MAX_RETRIES      = 5;

export function useSnapshotCapture() {
  const qc          = useQueryClient();
  const igAccountId = useAuthStore((s) => s.igAccountId);

  const [isPending,   setIsPending]   = useState(false);
  const [error,       setError]       = useState<Error | null>(null);
  const [progress,    setProgress]    = useState<JobProgress>({
    phase: null, pagesDone: 0, followersSeen: 0, followingSeen: 0, followingCached: false,
  });

  // Allow callers to cancel mid-flight
  const cancelled = useRef(false);

  const mutateAsync = useCallback(async (): Promise<CaptureResult> => {
    if (!igAccountId) throw new Error('No IG account selected.');

    cancelled.current = false;
    setIsPending(true);
    setError(null);
    setProgress({ phase: null, pagesDone: 0, followersSeen: 0, followingSeen: 0, followingCached: false });

    try {
      // ── Start ──
      let runFollowingCached = false;   // latched true once any response confirms cache

      const first = await startJob(igAccountId);
      if (first.followingCached) runFollowingCached = true;
      setProgress({
        phase:           first.phase,
        pagesDone:       first.pagesDone,
        followersSeen:   first.followersSeen,
        followingSeen:   first.followingSeen,
        followingCached: runFollowingCached,
      });

      if (first.done) {
        return finalise(first);
      }

      // ── Poll ──
      const jobId    = first.jobId;
      let   retries  = 0;
      let   current  = first;

      while (!current.done && !cancelled.current) {
        await delay(POLL_INTERVAL_MS);
        if (cancelled.current) break;

        try {
          current = await continueJob(jobId);
          if (current.followingCached) runFollowingCached = true;
          retries = 0;
          setProgress({
            phase:           current.phase,
            pagesDone:       current.pagesDone,
            followersSeen:   current.followersSeen,
            followingSeen:   current.followingSeen,
            followingCached: runFollowingCached,
          });
        } catch (pollErr) {
          retries++;
          if (retries >= MAX_RETRIES) throw pollErr;
          // Transient network error — back off 3 s and retry
          await delay(3_000);
        }
      }

      if (cancelled.current) throw new Error('Snapshot cancelled.');
      if (current.status === 'failed') {
        // Map job-level failure message to a SnapshotError with a code so the
        // UI can show appropriate guidance. The message often contains the code.
        const raw = current.error ?? current.message ?? 'Snapshot job failed.';
        const code = inferCodeFromMessage(raw);
        throw new SnapshotError(code, raw);
      }

      return finalise(current);

    } catch (err: any) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsPending(false);
      // Refresh data regardless of outcome
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['snapshot-history'] });
    }
  }, [igAccountId, qc]);

  const cancel = useCallback(() => { cancelled.current = true; }, []);
  const clearError = useCallback(() => setError(null), []);

  return {
    isPending,
    error,
    progress,
    mutateAsync,
    mutate: (opts?: { onSuccess?: (r: CaptureResult) => void; onError?: (e: Error) => void }) => {
      mutateAsync()
        .then(opts?.onSuccess)
        .catch(opts?.onError);
    },
    cancel,
    clearError,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function finalise(chunk: ChunkResponse): CaptureResult {
  return {
    jobId:   chunk.jobId,
    status:  chunk.status,
  };
}

/** Best-effort mapping from a raw job failure message to a typed code. */
function inferCodeFromMessage(msg: string): string {
  const m = msg.toUpperCase();
  if (m.includes('SESSION_EXPIRED') || m.includes('SESSION EXPIRED') || m.includes('IG_SESSION_INVALID')) return 'SESSION_EXPIRED';
  if (m.includes('CHALLENGE_REQUIRED') || m.includes('CHECKPOINT_REQUIRED')) return 'CHALLENGE_REQUIRED';
  if (m.includes('IG_RATE_LIMITED') || m.includes('RATE') || m.includes('THROTTL')) return 'IG_RATE_LIMITED';
  if (m.includes('SUSPICIOUS')) return 'SUSPICIOUS_RESPONSE';
  return 'INTERNAL_ERROR';
}

