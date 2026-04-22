// hooks/useSnapshotReconciliation.ts
// Reconciles local snapshot state against the backend on app resume,
// cold launch, notification tap, and dashboard mount.
//
// The backend is the single source of truth for snapshot job state.
// This module queries snapshot_jobs via Supabase RLS and determines
// what action the dashboard should take.

import { supabase } from '@/lib/supabase';
import { getActiveJob, clearActiveJob } from '@/lib/snapshotJobStore';
import { queryClient } from '@/lib/queryClient';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ServerJobState {
  jobId:           string;
  status:          'running' | 'queued' | 'complete' | 'failed';
  phase:           string;
  progressPercent: number;
  progressStage:   'started' | 'followers' | 'following' | 'finalize' | 'complete' | 'failed' | 'reconnect_required';
  followingCached: boolean;
  error:           string | null;
  failureCode:     string | null;
  completedAt:     string | null;
  startedAt:       string | null;
}

export type ReconciliationAction =
  | { type: 'none' }
  | { type: 'completed_while_away'; jobId: string }
  | { type: 'still_running'; jobId: string; progressPercent: number; progressStage: ServerJobState['progressStage']; followingCached: boolean }
  | { type: 'still_queued';  jobId: string; progressPercent: number; progressStage: ServerJobState['progressStage'] }
  | { type: 'failed'; jobId: string; failureCode: string; error: string }
  | { type: 'reconnect_required'; jobId: string }
  | { type: 'stale_cleared' };

// ── Server queries ─────────────────────────────────────────────────────────

/**
 * Fetch the most recent snapshot job for the given IG account.
 * Uses RLS — only the job owner's rows are returned.
 */
export async function fetchLatestJobState(igAccountId: string): Promise<ServerJobState | null> {
  try {
    const { data, error } = await supabase
      .from('snapshot_jobs')
      .select('id, status, phase, progress_percent, progress_stage, following_cached, error, failure_code, completed_at, started_at')
      .eq('ig_account_id', igAccountId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) {
      console.log('[reconciliation] No recent job found or query error:', error?.message);
      return null;
    }

    return {
      jobId:           data.id,
      status:          data.status,
      phase:           data.phase,
      progressPercent: data.progress_percent ?? 0,
      progressStage:   data.progress_stage   ?? 'started',
      followingCached: data.following_cached ?? false,
      error:           data.error,
      failureCode:     data.failure_code,
      completedAt:     data.completed_at,
      startedAt:       data.started_at,
    };
  } catch (err) {
    console.warn('[reconciliation] Failed to fetch latest job state:', (err as Error).message);
    return null;
  }
}

/**
 * Fetch a specific job by ID. Used when reconciling from a notification
 * tap or persisted job reference.
 */
export async function fetchJobById(jobId: string): Promise<ServerJobState | null> {
  try {
    const { data, error } = await supabase
      .from('snapshot_jobs')
      .select('id, status, phase, progress_percent, progress_stage, following_cached, error, failure_code, completed_at, started_at')
      .eq('id', jobId)
      .maybeSingle();

    if (error || !data) return null;

    return {
      jobId:           data.id,
      status:          data.status,
      phase:           data.phase,
      progressPercent: data.progress_percent ?? 0,
      progressStage:   data.progress_stage   ?? 'started',
      followingCached: data.following_cached ?? false,
      error:           data.error,
      failureCode:     data.failure_code,
      completedAt:     data.completed_at,
      startedAt:       data.started_at,
    };
  } catch (err) {
    console.warn('[reconciliation] Failed to fetch job by ID:', (err as Error).message);
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** Best-effort mapping from an error message to a typed code when
 *  the server's failure_code column is null. */
function inferCodeFromError(msg: string): string {
  const m = msg.toUpperCase();
  if (m.includes('SESSION_EXPIRED') || m.includes('IG_SESSION_INVALID')) return 'SESSION_EXPIRED';
  if (m.includes('IG_CHALLENGE_REQUIRED')) return 'IG_CHALLENGE_REQUIRED';
  if (m.includes('CHALLENGE_REQUIRED') || m.includes('CHECKPOINT_REQUIRED')) return 'CHALLENGE_REQUIRED';
  if (m.includes('IG_RATE_LIMITED') || m.includes('RATE') || m.includes('THROTTL')) return 'IG_RATE_LIMITED';
  if (m.includes('SUSPICIOUS')) return 'SUSPICIOUS_RESPONSE';
  if (m.includes('STALLED') || m.includes('ABANDONED')) return 'NETWORK_ERROR';
  return 'INTERNAL_ERROR';
}

const JOB_NOT_FOUND_RETRIES = 3;
const JOB_NOT_FOUND_DELAY_MS = 1_500;

// ── Reconciliation logic ───────────────────────────────────────────────────

/**
 * Performs full reconciliation for the given IG account:
 * 1. Checks persisted local job state (AsyncStorage)
 * 2. Fetches server state for that job (or latest job)
 * 3. Returns the appropriate action for the dashboard to take
 *
 * @param igAccountId       Current IG account
 * @param isCapturePending  True if the capture hook is currently polling (skip)
 * @param targetJobId       Optional job ID from a notification tap
 */
export async function reconcile(
  igAccountId: string,
  isCapturePending: boolean,
  targetJobId?: string,
): Promise<ReconciliationAction> {
  // If the capture hook is actively running, don't interfere.
  if (isCapturePending) {
    console.log('[reconciliation] Capture is active, skipping.');
    return { type: 'none' };
  }

  // 1. Check for a known active job in local storage
  const persisted = await getActiveJob();
  const jobIdToCheck = targetJobId ?? persisted?.jobId;

  console.log('[reconciliation] Persisted activeJobId:', persisted?.jobId ?? 'none',
    '| targetJobId:', targetJobId ?? 'none');

  let serverJob: ServerJobState | null = null;

  if (jobIdToCheck) {
    serverJob = await fetchJobById(jobIdToCheck);
    console.log('[reconciliation] Job', jobIdToCheck, '→',
      serverJob?.status ?? 'not found');
  }

  // If no specific job found, or it's already terminal, also check the latest
  // active job for this account (covers edge cases).
  if (!serverJob || (serverJob.status !== 'running' && serverJob.status !== 'queued')) {
    const latest = await fetchLatestJobState(igAccountId);

    if (latest && (latest.status === 'running' || latest.status === 'queued')) {
      serverJob = latest;
      console.log('[reconciliation] Found active latest job:', latest.jobId, '→', latest.status);
    }
  }

  if (!serverJob) {
    // No job found on server. If we had a persisted local job, the server
    // row may still be propagating (replication lag, edge function cold start).
    // Retry a few times before clearing the local state.
    if (persisted) {
      for (let attempt = 1; attempt <= JOB_NOT_FOUND_RETRIES; attempt++) {
        console.log(`[reconciliation] Persisted job not found on server, retry ${attempt}/${JOB_NOT_FOUND_RETRIES} after ${JOB_NOT_FOUND_DELAY_MS}ms…`);
        await delay(JOB_NOT_FOUND_DELAY_MS);

        // Re-check by ID first, then latest
        serverJob = await fetchJobById(persisted.jobId);
        if (!serverJob) {
          const latest = await fetchLatestJobState(igAccountId);
          if (latest && (latest.status === 'running' || latest.status === 'queued')) {
            serverJob = latest;
          }
        }
        if (serverJob) {
          console.log('[reconciliation] Found job on retry', attempt, '→', serverJob.status);
          break;
        }
      }

      if (!serverJob) {
        console.log('[reconciliation] Clearing stale persisted job after retries (no server match).');
        await clearActiveJob();
        return { type: 'stale_cleared' };
      }
    } else {
      return { type: 'none' };
    }
  }

  // 2. Branch based on server state
  switch (serverJob.status) {
    case 'complete': {
      // Is this "completed while we were away"?
      const weWereTracking =
        persisted?.jobId === serverJob.jobId ||
        (targetJobId != null && targetJobId === serverJob.jobId);

      if (weWereTracking) {
        console.log('[reconciliation] Job', serverJob.jobId, 'completed while app was away.');
        await clearActiveJob();
        // Invalidate data caches so dashboard shows latest
        queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        queryClient.invalidateQueries({ queryKey: ['list'] });
        queryClient.invalidateQueries({ queryKey: ['snapshot-history'] });
        return { type: 'completed_while_away', jobId: serverJob.jobId };
      }

      // It's a previously-completed job — not "just completed while away".
      if (persisted) await clearActiveJob();
      return { type: 'none' };
    }

    case 'running':
      console.log('[reconciliation] Job', serverJob.jobId,
        'is still running (stage:', serverJob.progressStage, ', percent:', serverJob.progressPercent, ')');
      return {
        type:            'still_running',
        jobId:           serverJob.jobId,
        progressPercent: serverJob.progressPercent,
        progressStage:   serverJob.progressStage,
        followingCached: serverJob.followingCached,
      };

    case 'queued':
      console.log('[reconciliation] Job', serverJob.jobId, 'is queued.');
      return {
        type:            'still_queued',
        jobId:           serverJob.jobId,
        progressPercent: serverJob.progressPercent,
        progressStage:   serverJob.progressStage,
      };

    case 'failed': {
      const errorMsg = serverJob.error ?? 'Snapshot failed.';
      // If the server didn't set a typed failure_code, try to infer one
      // from the error message so the UI shows actionable guidance instead
      // of a generic INTERNAL_ERROR.
      const failureCode = serverJob.failureCode ?? inferCodeFromError(errorMsg);
      console.log('[reconciliation] Job', serverJob.jobId,
        'failed — code:', failureCode, '(raw:', serverJob.failureCode, ') | msg:', errorMsg);
      await clearActiveJob();

      // Reconnect-required failures are not surfaced as errors —
      // the dashboard picks up tracking_state from diffs-latest
      // and shows a calm "tracking paused" banner instead.
      const RECONNECT_CODES = new Set([
        'SESSION_EXPIRED', 'IG_SESSION_INVALID',
        'CHALLENGE_REQUIRED', 'CHECKPOINT_REQUIRED', 'IG_CHALLENGE_REQUIRED',
        'RECONNECT_REQUIRED',
      ]);
      if (RECONNECT_CODES.has(failureCode)) {
        console.log('[reconciliation] Reconnect-required failure — suppressing error UI');
        return { type: 'reconnect_required', jobId: serverJob.jobId };
      }

      return {
        type:        'failed',
        jobId:       serverJob.jobId,
        failureCode,
        error:       errorMsg,
      };
    }

    default:
      return { type: 'none' };
  }
}
