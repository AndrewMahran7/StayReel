// hooks/useSnapshotCapture.ts
// Triggers the resumable snapshot job system (snapshot-start → poll snapshot-continue).
// Exposes live progress so the UI can show a progress bar.
// Exposes nextAllowedAt when a SNAPSHOT_LIMIT error is returned.

import { useState, useRef, useCallback, useEffect } from 'react';
import { AppState }                      from 'react-native';
import { useQueryClient }                from '@tanstack/react-query';
import { supabase }                      from '@/lib/supabase';
import { useAuthStore }                  from '@/store/authStore';
import {
  setSuppressSnapshotPush,
  registerForPushNotifications,
} from '@/lib/notifications';
import { setActiveJob, clearActiveJob }  from '@/lib/snapshotJobStore';

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
  phase:            'followers' | 'following' | 'finalize' | null;
  pagesDone:        number;
  followersSeen:    number;
  followingSeen:    number;
  followingCached:  boolean;
  followerCountApi: number;
  /** User-facing ETA string, e.g. "About 5 minutes remaining". Null until reliable. */
  etaLabel:         string | null;
  /** True when this is the account's first-ever snapshot (no ETA shown). */
  isFirstSnapshot:  boolean;
  /** True when server returned an existing running job rather than starting fresh. */
  resumed:          boolean;
  /** True when the job is queued waiting for a concurrency slot. */
  queued:           boolean;
  /** Server-provided message for queued state, e.g. "Waiting for an available slot…". */
  queueMessage:     string | null;
  /** Count of confirmed "doesn't follow back" users found so far (0 during followers phase). */
  partialNotFollowingBackCount: number;
  /** First few confirmed "doesn't follow back" users for live preview. */
  partialNotFollowingBackPreview: Array<{ig_id: string; username: string}>;
  /** True once followers phase is complete and following scan is active. */
  partialResultsReady: boolean;
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
  jobId:            string;
  status:           'running' | 'complete' | 'failed' | 'queued';
  phase:            'followers' | 'following' | 'finalize';
  pagesDone:        number;
  followersSeen:    number;
  followingSeen:    number;
  done:             boolean;
  followingCached?: boolean;
  followerCountApi?: number;
  followingCountApi?: number;
  error?:           string;
  message?:         string;
  /** Estimated remaining ms from the backend ETA formula. */
  etaMs?:           number | null;
  /** True when this is the account's first-ever snapshot. */
  isFirstSnapshot?: boolean;
  /** True when the server returned an already-running job (app resumed mid-scan). */
  resumed?:         boolean;
  /** Count of confirmed "doesn't follow back" users found so far (following phase only). */
  partialNotFollowingBackCount?: number;
  /** First few confirmed "doesn't follow back" users for live preview. */
  partialNotFollowingBackPreview?: Array<{ig_id: string; username: string}>;
  /** True once followers phase is complete and following scan is active. */
  partialResultsReady?: boolean;
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
    followerCountApi: 0, etaLabel: null, isFirstSnapshot: false, resumed: false, queued: false, queueMessage: null,
    partialNotFollowingBackCount: 0, partialNotFollowingBackPreview: [], partialResultsReady: false,
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
    setProgress({ phase: null, pagesDone: 0, followersSeen: 0, followingSeen: 0, followingCached: false, followerCountApi: 0, etaLabel: null, isFirstSnapshot: false, resumed: false, queued: false, queueMessage: null, partialNotFollowingBackCount: 0, partialNotFollowingBackPreview: [], partialResultsReady: false });

    // Suppress the server-sent "snapshot ready" foreground push while
    // the user is watching the live progress bar.
    setSuppressSnapshotPush(true);

    try {
      // ── Start ──
      let runFollowingCached = false;   // latched true once any response confirms cache
      let wasResumed         = false;   // latched true when server returns an existing running job

      const first = await startJob(igAccountId);
      if (first.followingCached) runFollowingCached = true;
      if (first.resumed) wasResumed = true;

      // Persist the active job so reconciliation can find it after
      // backgrounding, kill, or relaunch.
      setActiveJob({
        jobId:           first.jobId,
        igAccountId,
        lastKnownStatus: first.status === 'queued' ? 'queued' : 'running',
        startedAt:       new Date().toISOString(),
      }).catch(() => {});
      setProgress({
        phase:           first.phase,
        pagesDone:       first.pagesDone,
        followersSeen:   first.followersSeen,
        followingSeen:   first.followingSeen,
        followingCached: runFollowingCached,
        followerCountApi: first.followerCountApi ?? 0,
        etaLabel:        computeEtaLabel(first.etaMs),
        isFirstSnapshot: first.isFirstSnapshot ?? false,
        resumed:         wasResumed,
        queued:          first.status === 'queued',
        queueMessage:    first.status === 'queued' ? (first.message ?? 'Waiting for an available slot…') : null,
        partialNotFollowingBackCount:   first.partialNotFollowingBackCount   ?? 0,
        partialNotFollowingBackPreview: first.partialNotFollowingBackPreview ?? [],
        partialResultsReady:            first.partialResultsReady            ?? false,
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
            etaLabel:        computeEtaLabel(current.etaMs),
            isFirstSnapshot: current.isFirstSnapshot ?? false,
            resumed:         wasResumed,
            queued:          current.status === 'queued',
            queueMessage:    current.status === 'queued' ? (current.message ?? 'Waiting for an available slot…') : null,
            partialNotFollowingBackCount:   current.partialNotFollowingBackCount   ?? 0,
            partialNotFollowingBackPreview: current.partialNotFollowingBackPreview ?? [],
            partialResultsReady:            current.partialResultsReady            ?? false,
          });
        } catch (pollErr) {
          retries++;
          // When the app is backgrounded, network calls are expected to
          // fail (iOS suspends networking after ~30s). Don't burn retries
          // — just wait and try again when the app foregrounds. The server
          // continues the job via process-stale-jobs.
          if (AppState.currentState !== 'active') {
            retries--; // undo the increment — don't count background failures
            console.log('[snapshot] poll error while app inactive, waiting 5s before retry');
            await delay(5_000);
            continue;
          }
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
      // Clear the persisted active job — reconciliation no longer needed.
      clearActiveJob().catch(() => {});

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

  /** Allow external callers (e.g. reconciliation) to set an error so
   *  SnapshotErrorCard shows the correct server-side failure. */
  const setExternalError = useCallback((err: Error) => setError(err), []);

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
    setExternalError,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
/**
 * Converts a backend etaMs value to a short user-facing string.
 *
 * Design principles:
 *   • First-snapshot ETA is always null from the backend, so this
 *     never needs to handle isFirstSnapshot.
 *   • Broad buckets prevent the label from jumping every poll cycle.
 *   • “Finishing up” only appears in the last ~90 s of a run.
 *   • null / negative → suppress (estimate exceeded or unavailable).
 *
 * Thresholds:
 *   null / undefined   → null (no ETA shown)
 *   < 0                → null (exceeded historical estimate, suppress)
 *   0 – 90 s           → “Finishing up…”
 *   90 s – 3 min        → “A couple of minutes remaining”
 *   3 – 5 min           → “A few minutes remaining”
 *   ≥ 5 min             → “About N minutes remaining” (rounded to nearest 5)
 */
export function computeEtaLabel(etaMs: number | null | undefined): string | null {
  if (etaMs == null)     return null;
  if (etaMs < 0)         return null;            // exceeded estimate — suppress
  if (etaMs < 90_000)    return 'Finishing up\u2026';
  if (etaMs < 180_000)   return 'A couple of minutes remaining';
  if (etaMs < 300_000)   return 'A few minutes remaining';
  // Round to nearest 5-minute increment for stability.
  const mins    = Math.max(5, Math.round(etaMs / 60_000));
  const snapped = Math.round(mins / 5) * 5 || 5;  // minimum 5
  return `About ${snapped} minutes remaining`;
}
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
  // Check IG_CHALLENGE_REQUIRED before CHALLENGE_REQUIRED to avoid false match
  if (m.includes('IG_CHALLENGE_REQUIRED')) return 'IG_CHALLENGE_REQUIRED';
  if (m.includes('CHALLENGE_REQUIRED') || m.includes('CHECKPOINT_REQUIRED')) return 'CHALLENGE_REQUIRED';
  if (m.includes('IG_RATE_LIMITED') || m.includes('RATE') || m.includes('THROTTL')) return 'IG_RATE_LIMITED';
  if (m.includes('SUSPICIOUS')) return 'SUSPICIOUS_RESPONSE';
  // Network / connectivity errors should NOT map to INTERNAL_ERROR.
  // These indicate the client lost connection, not a server failure.
  if (m.includes('NETWORK') || m.includes('ABORT') || m.includes('TIMEOUT') ||
      m.includes('INTERNET') || m.includes('OFFLINE') || m.includes('FETCH') ||
      m.includes('ECONNREFUSED') || m.includes('ENOTFOUND')) return 'NETWORK_ERROR';
  return 'INTERNAL_ERROR';
}

