// hooks/useSnapshotCapture.ts
// Triggers the resumable snapshot job system (snapshot-start → poll snapshot-continue).
// Exposes live progress so the UI can show a progress bar.
// Exposes nextAllowedAt when a SNAPSHOT_LIMIT error is returned.

import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient }                from '@tanstack/react-query';
import { supabase }                      from '@/lib/supabase';
import { useAuthStore }                  from '@/store/authStore';
import {
  setSuppressSnapshotPush,
  registerForPushNotifications,
} from '@/lib/notifications';

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
  followerCountApi: number;
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

/**
 * Returns a guaranteed-fresh access token.
 *
 * `getSession()` reads from the AsyncStorage cache and can return an expired
 * JWT if the Android OS killed the auto-refresh timer while the app was
 * backgrounded. This helper proactively refreshes when the token is within
 * 60 seconds of expiry so the edge function never sees a stale Bearer token.
 */
async function getFreshAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();

  // Refresh proactively if the token expires within 60 seconds (or is already gone)
  const expiresAt = session?.expires_at ?? 0; // unix seconds
  const needsRefresh = !session?.access_token || (expiresAt * 1_000 - Date.now()) < 60_000;

  if (needsRefresh) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? '';
  }

  return session!.access_token;
}

/**
 * Returns true when the HTTP response is a Supabase Gateway-level 401
 * (body shape: {"code":401,"message":"Invalid JWT"}) as opposed to a
 * typed error from our own edge function (body shape: {"error":"..."}).
 */
function isGateway401(status: number, body: Record<string, unknown>): boolean {
  return status === 401 && !body.error && (body.code === 401 || typeof body.message === 'string');
}

/**
 * Forces a token refresh. Returns the new access token, or '' if refresh failed.
 */
async function forceRefresh(): Promise<string> {
  const { data } = await supabase.auth.refreshSession();
  return data.session?.access_token ?? '';
}

async function authHeaders(): Promise<HeadersInit> {
  return {
    'Content-Type': 'application/json',
    Authorization:  `Bearer ${await getFreshAccessToken()}`,
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
  followerCountApi?: number;
  followingCountApi?: number;
  error?:        string;
  message?:      string;
}

/** Fetch with an AbortController timeout so a hung edge function
 *  doesn’t block the poll loop forever. */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function startJob(igAccountId: string, isRetry = false): Promise<ChunkResponse> {
  const res = await fetchWithTimeout(`${BASE}/functions/v1/snapshot-start`, {
    method:  'POST',
    headers: await authHeaders(),
    body:    JSON.stringify({ ig_account_id: igAccountId, source: 'manual' }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body?.error === 'SNAPSHOT_LIMIT' && body?.detail?.next_allowed_at) {
      throw new SnapshotLimitError(body.detail.next_allowed_at, body.message ?? 'You can take one snapshot per hour.');
    }
    // If the server returned a typed error code, throw it directly — don't
    // treat IG errors (e.g. IG_SESSION_INVALID, HTTP 401) as a Supabase auth
    // failure. Only retry as UNAUTHORIZED when the body has *no* specific code.
    const serverCode: string | undefined = body?.error;
    if (serverCode && serverCode !== 'UNAUTHORIZED') {
      throw new SnapshotError(serverCode, body?.message ?? `HTTP ${res.status}`);
    }
    // Gateway-level 401 ({"code":401,"message":"Invalid JWT"}) or explicit
    // UNAUTHORIZED: try to refresh the token once and retry.
    if (res.status === 401 || serverCode === 'UNAUTHORIZED' || isGateway401(res.status, body)) {
      if (!isRetry) {
        const newToken = await forceRefresh();
        // forceRefresh() signs out if the refresh token is also invalid,
        // which triggers AuthGuard to redirect to sign-in. Still throw so
        // the UI doesn't hang, but use a message that won't be shown long.
        if (!newToken) {
          throw new SnapshotError('UNAUTHORIZED', 'Session expired. Signing you out…');
        }
        return startJob(igAccountId, true);
      }
      throw new SnapshotError('UNAUTHORIZED', 'Session expired. Please sign out and sign back in.');
    }
    throw new SnapshotError(serverCode ?? 'UNKNOWN', body?.message ?? `HTTP ${res.status}`);
  }
  return body as ChunkResponse;
}

async function continueJob(jobId: string, isRetry = false): Promise<ChunkResponse> {
  const res = await fetchWithTimeout(`${BASE}/functions/v1/snapshot-continue`, {
    method:  'POST',
    headers: await authHeaders(),
    body:    JSON.stringify({ job_id: jobId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const serverCode: string | undefined = body?.error;
    if (serverCode && serverCode !== 'UNAUTHORIZED') {
      throw new SnapshotError(serverCode, body?.message ?? `HTTP ${res.status}`);
    }
    if (res.status === 401 || serverCode === 'UNAUTHORIZED' || isGateway401(res.status, body)) {
      if (!isRetry) {
        const newToken = await forceRefresh();
        if (!newToken) {
          throw new SnapshotError('UNAUTHORIZED', 'Session expired. Signing you out…');
        }
        return continueJob(jobId, true);
      }
      throw new SnapshotError('UNAUTHORIZED', 'Session expired. Please sign out and sign back in.');
    }
    throw new SnapshotError(serverCode ?? 'UNKNOWN', body?.message ?? `HTTP ${res.status}`);
  }
  return body as ChunkResponse;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 2_000;
const MAX_RETRIES      = 8;

export function useSnapshotCapture() {
  const qc          = useQueryClient();
  const igAccountId = useAuthStore((s) => s.igAccountId);

  const [isPending,   setIsPending]   = useState(false);
  const [error,       setError]       = useState<Error | null>(null);
  const [progress,    setProgress]    = useState<JobProgress>({
    phase: null, pagesDone: 0, followersSeen: 0, followingSeen: 0, followingCached: false,
  });

  // Clear any stale error whenever the account changes (sign-out / sign-in
  // or switching accounts). This ensures fast-refresh-preserved errors from
  // a previous session are never shown to a freshly signed-in user.
  const prevIgAccountIdRef = useRef(igAccountId);
  useEffect(() => {
    if (prevIgAccountIdRef.current !== igAccountId) {
      prevIgAccountIdRef.current = igAccountId;
      setError(null);
    }
  }, [igAccountId]);

  // Allow callers to cancel mid-flight
  const cancelled = useRef(false);

  const mutateAsync = useCallback(async (): Promise<CaptureResult> => {
    console.log('[mutateAsync] called, igAccountId:', igAccountId);
    if (!igAccountId) throw new Error('No IG account selected.');

    cancelled.current = false;
    setIsPending(true);
    setError(null);
    setProgress({ phase: null, pagesDone: 0, followersSeen: 0, followingSeen: 0, followingCached: false, followerCountApi: 0 });

    // Suppress the server-sent "snapshot ready" foreground push while
    // the user is watching the live progress bar.
    setSuppressSnapshotPush(true);

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
        followerCountApi: first.followerCountApi ?? 0,
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
            followerCountApi: current.followerCountApi ?? 0,
          });
        } catch (pollErr) {
          retries++;
          console.warn(`[snapshot] poll retry ${retries}/${MAX_RETRIES}:`, (pollErr as Error).message);
          if (retries >= MAX_RETRIES) throw pollErr;
          // Exponential backoff: 3s, 6s, 12s, 24s, ...
          await delay(3_000 * Math.pow(2, retries - 1));
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

      // Keep the suppression window open for 15 s after the poll loop
      // ends — the server push may still be in-flight.
      setTimeout(() => setSuppressSnapshotPush(false), 15_000);

      // After a successful snapshot, prompt for push-notification
      // permission if the user hasn't been asked yet.  This is the
      // ideal "value moment" — they just saw their first result.
      registerForPushNotifications().catch(() => {});
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

