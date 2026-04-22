// hooks/useSnapshotCapture.ts
//
// Server-owned snapshot lifecycle (post-030):
//   • The user taps "Take Snapshot".
//   • The client POSTs to snapshot-start, which creates the job, sends the
//     STARTED push notification, and triggers snapshot-worker on the backend.
//   • The client returns immediately. There is NO polling, NO continuation,
//     and NO chunk orchestration on the client.
//   • Progress milestones (25 / 50 / 75 / almost / complete / failed /
//     reconnect_required) arrive as push notifications.
//   • The dashboard re-fetches state on focus, foreground, and notification
//     receipt. Live progress is synced via reconciliation, not polling.
//
// Public API:
//   isPending, error, progress, mutateAsync, mutate, cancel, clearError,
//   setExternalError, setProgress  (last one is for reconciliation sync)

import { useState, useRef, useCallback, useEffect } from 'react';
import { useQueryClient }           from '@tanstack/react-query';
import { supabase }                 from '@/lib/supabase';
import { useAuthStore }             from '@/store/authStore';
import { registerForPushNotifications } from '@/lib/notifications';
import { setActiveJob, clearActiveJob } from '@/lib/snapshotJobStore';

// ── Public types ─────────────────────────────────────────────────────────

export type ProgressStage =
  | 'started'
  | 'followers'
  | 'following'
  | 'finalize'
  | 'complete'
  | 'failed'
  | 'reconnect_required';

export interface CaptureResult {
  jobId?:            string;
  status?:           string;
  progress_percent?: number;
  progress_stage?:   ProgressStage;
}

export interface JobProgress {
  /** Job lifecycle stage as reported by the server. */
  stage: ProgressStage | null;
  /** 0–100, monotonic non-decreasing on the server, capped at 99 until complete. */
  percent: number;
  /** True when the job is queued waiting for a concurrency slot. */
  queued: boolean;
  /** Server-provided message for queued state. */
  queueMessage: string | null;
  /** True when the server returned an existing running job (resume path). */
  resumed: boolean;
  /** True when the following list is served from a 24h cache. */
  followingCached: boolean;
}

export class SnapshotError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export class SnapshotLimitError extends SnapshotError {
  constructor(public readonly nextAllowedAt: string, message: string) {
    super('SNAPSHOT_LIMIT', message);
    this.name = 'SnapshotLimitError';
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────

const BASE = process.env.EXPO_PUBLIC_SUPABASE_URL;
const ANON = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

async function getFreshAccessToken(): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const expiresAt = session?.expires_at ?? 0;
  const needsRefresh = !session?.access_token || (expiresAt * 1_000 - Date.now()) < 60_000;
  if (needsRefresh) {
    const { data } = await supabase.auth.refreshSession();
    return data.session?.access_token ?? '';
  }
  return session!.access_token;
}

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

function isGateway401(status: number, body: Record<string, unknown>): boolean {
  return status === 401 && !body.error && (body.code === 401 || typeof body.message === 'string');
}

interface StartResponse {
  jobId:            string;
  status:           'running' | 'complete' | 'failed' | 'queued';
  phase:            'followers' | 'following' | 'finalize';
  progress_percent: number;
  progress_stage:   ProgressStage;
  followingCached:  boolean;
  resumed:          boolean;
  message?:         string;
  reconnect_required?: boolean;
}

const RECONNECT_FAILURE_CODES = new Set([
  'SESSION_EXPIRED', 'IG_SESSION_INVALID',
  'CHALLENGE_REQUIRED', 'CHECKPOINT_REQUIRED', 'IG_CHALLENGE_REQUIRED',
  'RECONNECT_REQUIRED',
]);

async function startJob(igAccountId: string, isRetry = false): Promise<StartResponse> {
  const res = await fetch(`${BASE}/functions/v1/snapshot-start`, {
    method:  'POST',
    headers: await authHeaders(),
    body:    JSON.stringify({ ig_account_id: igAccountId, source: 'manual' }),
  });
  const body = await res.json().catch(() => ({}));

  if (body?.reconnect_required === true) {
    return {
      jobId: '', status: 'failed', phase: 'followers',
      progress_percent: 0, progress_stage: 'reconnect_required',
      followingCached: false, resumed: false, reconnect_required: true,
    };
  }

  if (!res.ok) {
    if (body?.error === 'SNAPSHOT_LIMIT' && body?.detail?.next_allowed_at) {
      throw new SnapshotLimitError(body.detail.next_allowed_at, body.message ?? 'You can take one snapshot per hour.');
    }
    const serverCode: string | undefined = body?.error;
    if (serverCode && serverCode !== 'UNAUTHORIZED') {
      if (RECONNECT_FAILURE_CODES.has(serverCode)) {
        return {
          jobId: '', status: 'failed', phase: 'followers',
          progress_percent: 0, progress_stage: 'reconnect_required',
          followingCached: false, resumed: false, reconnect_required: true,
        };
      }
      throw new SnapshotError(serverCode, body?.message ?? `HTTP ${res.status}`);
    }
    if (res.status === 401 || serverCode === 'UNAUTHORIZED' || isGateway401(res.status, body)) {
      if (!isRetry) {
        const newToken = await forceRefresh();
        if (!newToken) throw new SnapshotError('UNAUTHORIZED', 'Session expired. Signing you out…');
        return startJob(igAccountId, true);
      }
      throw new SnapshotError('UNAUTHORIZED', 'Session expired. Please sign out and sign back in.');
    }
    throw new SnapshotError(serverCode ?? 'UNKNOWN', body?.message ?? `HTTP ${res.status}`);
  }
  return body as StartResponse;
}

// ── Hook ────────────────────────────────────────────────────────────────

const INITIAL_PROGRESS: JobProgress = {
  stage:           null,
  percent:         0,
  queued:          false,
  queueMessage:    null,
  resumed:         false,
  followingCached: false,
};

export function useSnapshotCapture() {
  const qc          = useQueryClient();
  const igAccountId = useAuthStore((s) => s.igAccountId);

  const [isPending, setIsPending] = useState(false);
  const [error,     setError]     = useState<Error | null>(null);
  const [progress,  setProgress]  = useState<JobProgress>(INITIAL_PROGRESS);

  // Reset state on account switch — never carry stale progress/error across.
  const prevIgAccountIdRef = useRef(igAccountId);
  useEffect(() => {
    if (prevIgAccountIdRef.current !== igAccountId) {
      prevIgAccountIdRef.current = igAccountId;
      setError(null);
      setProgress(INITIAL_PROGRESS);
    }
  }, [igAccountId]);

  const mutateAsync = useCallback(async (): Promise<CaptureResult> => {
    if (!igAccountId) throw new Error('No IG account selected.');

    setIsPending(true);
    setError(null);
    setProgress(INITIAL_PROGRESS);

    try {
      const start = await startJob(igAccountId);

      if (start.reconnect_required) {
        setProgress({ ...INITIAL_PROGRESS, stage: 'reconnect_required' });
        return { jobId: start.jobId, status: 'failed' };
      }

      if (start.jobId) {
        setActiveJob({
          jobId:           start.jobId,
          igAccountId,
          lastKnownStatus: start.status === 'queued' ? 'queued' : 'running',
          startedAt:       new Date().toISOString(),
        }).catch(() => {});
      }

      setProgress({
        stage:           start.progress_stage ?? 'started',
        percent:         start.progress_percent ?? 0,
        queued:          start.status === 'queued',
        queueMessage:    start.status === 'queued' ? (start.message ?? 'Waiting for an available slot…') : null,
        resumed:         start.resumed,
        followingCached: start.followingCached,
      });

      return {
        jobId:            start.jobId,
        status:           start.status,
        progress_percent: start.progress_percent,
        progress_stage:   start.progress_stage,
      };

    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      throw e;
    } finally {
      setIsPending(false);

      // Server-owned model: snapshot-start returns immediately. The job runs
      // in the background and the client is notified via push. We clear the
      // local active-job marker once the start request has returned (success
      // or failure) — reconciliation re-establishes it from the server when
      // needed.
      clearActiveJob().catch(() => {});

      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['list'] });
      qc.invalidateQueries({ queryKey: ['snapshot-history'] });

      // Best moment to ask for push permission — they just opted into a
      // background job and need notifications to know when it finishes.
      registerForPushNotifications().catch(() => {});
    }
  }, [igAccountId, qc]);

  // ── Imperative setters used by reconciliation / external callers ─────
  const cancel        = useCallback(() => { /* no-op: backend owns the job */ }, []);
  const clearError    = useCallback(() => setError(null), []);
  const setExternalError    = useCallback((err: Error) => setError(err), []);
  const setExternalProgress = useCallback((next: Partial<JobProgress>) => {
    setProgress((prev) => ({ ...prev, ...next }));
  }, []);
  const resetProgress = useCallback(() => setProgress(INITIAL_PROGRESS), []);

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
    setExternalProgress,
    resetProgress,
    setIsPending,
  };
}

