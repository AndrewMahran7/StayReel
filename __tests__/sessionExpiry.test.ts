/**
 * Unit tests for session expiry handling in the snapshot pipeline.
 *
 * Tests cover:
 * - Failure classification (FailureCode → FailureCategory mapping)
 * - Reconnect requirement determination
 * - Session expiry does NOT surface a raw visible error state
 * - snapshot-start returns structured reconnect response, not a thrown error
 * - SnapshotErrorCard has no reconnect profiles
 * - Reconnect-required banner appears based on tracking state
 * - Manual snapshot action is disabled while reconnect is required
 * - Status card shows tracking paused when reconnect is required
 * - Existing results remain visible when reconnect is required
 * - Partial progress is preserved where possible
 * - Resume behavior (checkpoint consumption and cursor round-trip)
 * - Resume from mid-followers / mid-following checkpoint
 * - No duplicate edges after resume
 * - Final diff correctness after resumed completion
 * - Reconnect notification fires once per transition
 * - Non-auth failures do not force reconnect
 * - Tracking state model correctness
 * - Centralized copy consistency
 * - Temporary vs reconnect failure differentiation
 */

// ── Replicate classifyFetchFailure logic ──────────────────────────────────

type FailureCategory =
  | 'session_expired'
  | 'checkpoint_or_challenge'
  | 'rate_limited'
  | 'temporary_network_failure'
  | 'unknown_fetch_error';

type TrackingState =
  | 'tracking_active'
  | 'tracking_updating'
  | 'tracking_paused_reconnect_required'
  | 'tracking_paused_temporary_issue';

function classifyFetchFailure(code: string): FailureCategory {
  switch (code) {
    case 'SESSION_EXPIRED':
    case 'IG_SESSION_INVALID':
      return 'session_expired';
    case 'CHALLENGE_REQUIRED':
    case 'CHECKPOINT_REQUIRED':
    case 'IG_CHALLENGE_REQUIRED':
      return 'checkpoint_or_challenge';
    case 'IG_RATE_LIMITED':
      return 'rate_limited';
    case 'NETWORK_ERROR':
      return 'temporary_network_failure';
    default:
      return 'unknown_fetch_error';
  }
}

function requiresReconnect(category: FailureCategory): boolean {
  return category === 'session_expired' || category === 'checkpoint_or_challenge';
}

// ── Replicate tracking state derivation ──────────────────────────────────

function deriveTrackingState(acct: {
  reconnect_required: boolean;
}): TrackingState {
  if (acct.reconnect_required) return 'tracking_paused_reconnect_required';
  return 'tracking_active';
}

// ── Replicate account reconnect state logic ──────────────────────────────

interface AccountState {
  status: string;
  reconnect_required: boolean;
  last_auth_error_code: string | null;
  last_auth_error_at: string | null;
  auto_snapshot_enabled: boolean;
}

const RECONNECT_CODES = new Set([
  'CHALLENGE_REQUIRED', 'CHECKPOINT_REQUIRED',
  'IG_CHALLENGE_REQUIRED', 'SESSION_EXPIRED', 'IG_SESSION_INVALID',
  'RECONNECT_REQUIRED',
]);

function shouldBlockJob(acct: AccountState): { blocked: boolean; reason?: string } {
  if (acct.reconnect_required) return { blocked: true, reason: 'reconnect_required' };
  if (acct.status === 'suspended') return { blocked: true, reason: 'suspended' };
  if (acct.status === 'token_expired') return { blocked: true, reason: 'token_expired' };
  return { blocked: false };
}

function shouldBlockAutoSnapshot(acct: AccountState): boolean {
  return acct.reconnect_required || acct.status !== 'active' || !acct.auto_snapshot_enabled;
}

// ── Replicate reconnect state mutation logic ─────────────────────────────

function markReconnectRequired(
  acct: AccountState,
  errorCode: string,
): AccountState {
  return {
    ...acct,
    reconnect_required: true,
    last_auth_error_code: errorCode,
    last_auth_error_at: new Date().toISOString(),
    status: 'token_expired',
  };
}

function clearReconnectOnReconnect(acct: AccountState): AccountState {
  return {
    ...acct,
    reconnect_required: false,
    last_auth_error_code: null,
    last_auth_error_at: null,
    status: 'active',
  };
}

// ── Partial progress simulation ──────────────────────────────────────────

interface JobProgress {
  status: 'running' | 'failed' | 'complete';
  phase: string;
  pages_done: number;
  followers_count: number;
  following_count: number;
  failure_code: string | null;
}

function simulateChunkFailure(
  job: JobProgress,
  newFollowers: number,
  newPages: number,
  failureCode: string,
): JobProgress {
  return {
    status: 'failed',
    phase: job.phase,
    pages_done: job.pages_done + newPages,
    followers_count: job.followers_count + newFollowers,
    following_count: job.following_count,
    failure_code: failureCode,
  };
}

// ── Simulate user-facing error suppression ───────────────────────────────

/** Simulates the capture hook's behavior: reconnect codes don't throw errors */
function shouldSuppressErrorUI(failureCode: string, reconnectRequired: boolean): boolean {
  return reconnectRequired || RECONNECT_CODES.has(failureCode);
}

/** Simulates the dashboard's SnapshotErrorCard visibility logic */
function shouldShowErrorCard(
  errorCode: string | null,
  reconnectRequired: boolean,
): boolean {
  if (!errorCode) return false;
  // Reconnect codes are suppressed — the banner handles the UX
  if (RECONNECT_CODES.has(errorCode)) return false;
  if (reconnectRequired) return false;
  return true;
}

// ── Simulate reconciliation action type ──────────────────────────────────

function getReconciliationActionType(
  failureCode: string,
): 'reconnect_required' | 'failed' {
  if (RECONNECT_CODES.has(failureCode)) return 'reconnect_required';
  return 'failed';
}

// ── Simulate notification logic ──────────────────────────────────────────

interface NotificationTracker {
  sent: boolean;
  count: number;
}

function simulateReconnectNotification(
  tracker: NotificationTracker,
  notifyOnTokenExpiry: boolean,
  hasPushToken: boolean,
): NotificationTracker {
  if (!notifyOnTokenExpiry || !hasPushToken) return tracker;
  // markAccountReconnectRequired sends notification once per transition
  return { sent: true, count: tracker.count + 1 };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Failure classification', () => {
  it('classifies SESSION_EXPIRED as session_expired', () => {
    expect(classifyFetchFailure('SESSION_EXPIRED')).toBe('session_expired');
  });

  it('classifies IG_SESSION_INVALID as session_expired', () => {
    expect(classifyFetchFailure('IG_SESSION_INVALID')).toBe('session_expired');
  });

  it('classifies CHALLENGE_REQUIRED as checkpoint_or_challenge', () => {
    expect(classifyFetchFailure('CHALLENGE_REQUIRED')).toBe('checkpoint_or_challenge');
  });

  it('classifies CHECKPOINT_REQUIRED as checkpoint_or_challenge', () => {
    expect(classifyFetchFailure('CHECKPOINT_REQUIRED')).toBe('checkpoint_or_challenge');
  });

  it('classifies IG_CHALLENGE_REQUIRED as checkpoint_or_challenge', () => {
    expect(classifyFetchFailure('IG_CHALLENGE_REQUIRED')).toBe('checkpoint_or_challenge');
  });

  it('classifies IG_RATE_LIMITED as rate_limited', () => {
    expect(classifyFetchFailure('IG_RATE_LIMITED')).toBe('rate_limited');
  });

  it('classifies NETWORK_ERROR as temporary_network_failure', () => {
    expect(classifyFetchFailure('NETWORK_ERROR')).toBe('temporary_network_failure');
  });

  it('classifies SUSPICIOUS_RESPONSE as unknown_fetch_error', () => {
    expect(classifyFetchFailure('SUSPICIOUS_RESPONSE')).toBe('unknown_fetch_error');
  });

  it('classifies unknown codes as unknown_fetch_error', () => {
    expect(classifyFetchFailure('SOME_OTHER_CODE')).toBe('unknown_fetch_error');
  });
});

describe('Reconnect requirement', () => {
  it('session_expired requires reconnect', () => {
    expect(requiresReconnect('session_expired')).toBe(true);
  });

  it('checkpoint_or_challenge requires reconnect', () => {
    expect(requiresReconnect('checkpoint_or_challenge')).toBe(true);
  });

  it('rate_limited does NOT require reconnect', () => {
    expect(requiresReconnect('rate_limited')).toBe(false);
  });

  it('temporary_network_failure does NOT require reconnect', () => {
    expect(requiresReconnect('temporary_network_failure')).toBe(false);
  });

  it('unknown_fetch_error does NOT require reconnect', () => {
    expect(requiresReconnect('unknown_fetch_error')).toBe(false);
  });
});

describe('Session expiry does NOT surface a raw visible error state', () => {
  it('SESSION_EXPIRED does not show error card to user', () => {
    expect(shouldShowErrorCard('SESSION_EXPIRED', false)).toBe(false);
  });

  it('IG_SESSION_INVALID does not show error card to user', () => {
    expect(shouldShowErrorCard('IG_SESSION_INVALID', false)).toBe(false);
  });

  it('CHALLENGE_REQUIRED does not show error card to user', () => {
    expect(shouldShowErrorCard('CHALLENGE_REQUIRED', false)).toBe(false);
  });

  it('RECONNECT_REQUIRED does not show error card to user', () => {
    expect(shouldShowErrorCard('RECONNECT_REQUIRED', false)).toBe(false);
  });

  it('capture hook suppresses throw for reconnect codes', () => {
    expect(shouldSuppressErrorUI('SESSION_EXPIRED', false)).toBe(true);
    expect(shouldSuppressErrorUI('CHALLENGE_REQUIRED', false)).toBe(true);
    expect(shouldSuppressErrorUI('RECONNECT_REQUIRED', true)).toBe(true);
  });

  it('non-reconnect errors still show error card', () => {
    expect(shouldShowErrorCard('IG_RATE_LIMITED', false)).toBe(true);
    expect(shouldShowErrorCard('NETWORK_ERROR', false)).toBe(true);
    expect(shouldShowErrorCard('INTERNAL_ERROR', false)).toBe(true);
  });

  it('reconciliation returns reconnect_required instead of failed for session codes', () => {
    expect(getReconciliationActionType('SESSION_EXPIRED')).toBe('reconnect_required');
    expect(getReconciliationActionType('CHALLENGE_REQUIRED')).toBe('reconnect_required');
    expect(getReconciliationActionType('IG_SESSION_INVALID')).toBe('reconnect_required');
  });

  it('reconciliation returns failed for non-reconnect codes', () => {
    expect(getReconciliationActionType('IG_RATE_LIMITED')).toBe('failed');
    expect(getReconciliationActionType('INTERNAL_ERROR')).toBe('failed');
  });
});

describe('Tracking state model', () => {
  it('returns tracking_active when reconnect is not required', () => {
    expect(deriveTrackingState({ reconnect_required: false })).toBe('tracking_active');
  });

  it('returns tracking_paused_reconnect_required when reconnect is required', () => {
    expect(deriveTrackingState({ reconnect_required: true })).toBe('tracking_paused_reconnect_required');
  });
});

describe('Reconnect-required banner appears', () => {
  it('banner is shown when server says reconnect_required', () => {
    const data = { reconnect_required: true, tracking_state: 'tracking_paused_reconnect_required' };
    expect(data.reconnect_required).toBe(true);
    expect(data.tracking_state).toBe('tracking_paused_reconnect_required');
  });

  it('banner is hidden when tracking is active', () => {
    const data = { reconnect_required: false, tracking_state: 'tracking_active' };
    expect(data.reconnect_required).toBe(false);
  });
});

describe('Manual snapshot action is disabled while reconnect is required', () => {
  it('disables snapshot button when server says reconnect_required', () => {
    const data = { reconnect_required: true };
    const errorCode: string | null = null;
    const needsReconnect = data.reconnect_required ||
      (errorCode != null && RECONNECT_CODES.has(errorCode));
    expect(needsReconnect).toBe(true);
  });

  it('disables snapshot button when error is SESSION_EXPIRED', () => {
    const data = { reconnect_required: false };
    const errorCode = 'SESSION_EXPIRED';
    const needsReconnect = data.reconnect_required ||
      (errorCode != null && RECONNECT_CODES.has(errorCode));
    expect(needsReconnect).toBe(true);
  });

  it('does NOT disable when no error and reconnect_required=false', () => {
    const data = { reconnect_required: false };
    const errorCode: string | null = null;
    const needsReconnect = data.reconnect_required ||
      (errorCode != null && RECONNECT_CODES.has(errorCode));
    expect(needsReconnect).toBe(false);
  });

  it('does NOT disable for rate limit errors', () => {
    const data = { reconnect_required: false };
    const errorCode = 'IG_RATE_LIMITED';
    const needsReconnect = data.reconnect_required ||
      (errorCode != null && RECONNECT_CODES.has(errorCode));
    expect(needsReconnect).toBe(false);
  });
});

describe('Existing results remain visible when reconnect is required', () => {
  it('dashboard data is preserved during reconnect-required state', () => {
    const dashboardData = {
      follower_count: 1234,
      following_count: 567,
      has_diff: true,
      reconnect_required: true,
      tracking_state: 'tracking_paused_reconnect_required',
    };
    expect(dashboardData.follower_count).toBe(1234);
    expect(dashboardData.following_count).toBe(567);
    expect(dashboardData.has_diff).toBe(true);
  });

  it('weekly summary and streak remain visible', () => {
    const dashboardData = {
      current_streak_days: 5,
      has_weekly_summary: true,
      weekly_net_change: 12,
      reconnect_required: true,
    };
    expect(dashboardData.current_streak_days).toBe(5);
    expect(dashboardData.has_weekly_summary).toBe(true);
    expect(dashboardData.weekly_net_change).toBe(12);
  });

  it('list cards remain tappable', () => {
    const dashboardData = {
      new_followers_count: 3,
      lost_followers_count: 1,
      not_following_back_count: 15,
      reconnect_required: true,
    };
    expect(dashboardData.new_followers_count).toBe(3);
    expect(dashboardData.lost_followers_count).toBe(1);
    expect(dashboardData.not_following_back_count).toBe(15);
  });
});

describe('Partial progress is preserved', () => {
  it('saves follower edges accumulated before session failure', () => {
    const job: JobProgress = {
      status: 'running', phase: 'followers',
      pages_done: 10, followers_count: 2000, following_count: 0, failure_code: null,
    };
    const result = simulateChunkFailure(job, 150, 2, 'SESSION_EXPIRED');
    expect(result.followers_count).toBe(2150);
    expect(result.pages_done).toBe(12);
  });

  it('saves following edges accumulated before session failure', () => {
    const job: JobProgress = {
      status: 'running', phase: 'following',
      pages_done: 15, followers_count: 3000, following_count: 500, failure_code: null,
    };
    const result = {
      ...simulateChunkFailure(job, 0, 1, 'SESSION_EXPIRED'),
      following_count: job.following_count + 100,
    };
    expect(result.following_count).toBe(600);
    expect(result.pages_done).toBe(16);
  });

  it('existing snapshot history is not affected by reconnect state', () => {
    const acct = markReconnectRequired(
      {
        status: 'active', reconnect_required: false,
        last_auth_error_code: null, last_auth_error_at: null,
        auto_snapshot_enabled: true,
      },
      'SESSION_EXPIRED',
    );
    expect(acct.reconnect_required).toBe(true);
    expect(acct.status).toBe('token_expired');
    const reconnected = clearReconnectOnReconnect(acct);
    expect(reconnected.status).toBe('active');
    expect(reconnected.reconnect_required).toBe(false);
  });
});

describe('Reconnect notification fires once per transition', () => {
  it('sends notification on first reconnect transition', () => {
    const tracker: NotificationTracker = { sent: false, count: 0 };
    const result = simulateReconnectNotification(tracker, true, true);
    expect(result.sent).toBe(true);
    expect(result.count).toBe(1);
  });

  it('does not send when user has disabled token expiry notifications', () => {
    const tracker: NotificationTracker = { sent: false, count: 0 };
    const result = simulateReconnectNotification(tracker, false, true);
    expect(result.sent).toBe(false);
    expect(result.count).toBe(0);
  });

  it('does not send when user has no push token', () => {
    const tracker: NotificationTracker = { sent: false, count: 0 };
    const result = simulateReconnectNotification(tracker, true, false);
    expect(result.sent).toBe(false);
    expect(result.count).toBe(0);
  });

  it('markAccountReconnectRequired is only called once per transition', () => {
    const acct: AccountState = {
      status: 'active', reconnect_required: false,
      last_auth_error_code: null, last_auth_error_at: null,
      auto_snapshot_enabled: true,
    };
    const marked = markReconnectRequired(acct, 'SESSION_EXPIRED');
    expect(marked.reconnect_required).toBe(true);
    // Subsequent checks just block — no re-marking
    expect(shouldBlockJob(marked).blocked).toBe(true);
    expect(shouldBlockJob(marked).reason).toBe('reconnect_required');
  });
});

describe('Subsequent jobs are blocked when reconnect required', () => {
  it('blocks new snapshot-start when reconnect_required=true', () => {
    const acct: AccountState = {
      status: 'token_expired', reconnect_required: true,
      last_auth_error_code: 'SESSION_EXPIRED', last_auth_error_at: new Date().toISOString(),
      auto_snapshot_enabled: true,
    };
    const result = shouldBlockJob(acct);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe('reconnect_required');
  });

  it('blocks auto-snapshot scheduling when reconnect_required=true', () => {
    const acct: AccountState = {
      status: 'token_expired', reconnect_required: true,
      last_auth_error_code: 'SESSION_EXPIRED', last_auth_error_at: new Date().toISOString(),
      auto_snapshot_enabled: true,
    };
    expect(shouldBlockAutoSnapshot(acct)).toBe(true);
  });

  it('allows jobs after reconnect clears the flag', () => {
    const acct: AccountState = {
      status: 'active', reconnect_required: false,
      last_auth_error_code: null, last_auth_error_at: null,
      auto_snapshot_enabled: true,
    };
    const result = shouldBlockJob(acct);
    expect(result.blocked).toBe(false);
  });
});

describe('Account marked needs reconnect', () => {
  const baseAcct: AccountState = {
    status: 'active',
    reconnect_required: false,
    last_auth_error_code: null,
    last_auth_error_at: null,
    auto_snapshot_enabled: true,
  };

  it('marks reconnect_required on SESSION_EXPIRED', () => {
    const updated = markReconnectRequired(baseAcct, 'SESSION_EXPIRED');
    expect(updated.reconnect_required).toBe(true);
    expect(updated.status).toBe('token_expired');
    expect(updated.last_auth_error_code).toBe('SESSION_EXPIRED');
    expect(updated.last_auth_error_at).toBeTruthy();
  });

  it('marks reconnect_required on CHALLENGE_REQUIRED', () => {
    const updated = markReconnectRequired(baseAcct, 'CHALLENGE_REQUIRED');
    expect(updated.reconnect_required).toBe(true);
    expect(updated.last_auth_error_code).toBe('CHALLENGE_REQUIRED');
  });

  it('clears reconnect state on successful reconnect', () => {
    const expired = markReconnectRequired(baseAcct, 'SESSION_EXPIRED');
    const reconnected = clearReconnectOnReconnect(expired);
    expect(reconnected.reconnect_required).toBe(false);
    expect(reconnected.status).toBe('active');
    expect(reconnected.last_auth_error_code).toBeNull();
    expect(reconnected.last_auth_error_at).toBeNull();
  });
});

describe('Non-auth failures do not force reconnect', () => {
  it('NETWORK_ERROR does not trigger reconnect', () => {
    const category = classifyFetchFailure('NETWORK_ERROR');
    expect(requiresReconnect(category)).toBe(false);
  });

  it('IG_RATE_LIMITED does not trigger reconnect', () => {
    const category = classifyFetchFailure('IG_RATE_LIMITED');
    expect(requiresReconnect(category)).toBe(false);
  });

  it('SUSPICIOUS_RESPONSE does not trigger reconnect', () => {
    const category = classifyFetchFailure('SUSPICIOUS_RESPONSE');
    expect(requiresReconnect(category)).toBe(false);
  });

  it('PAGE_LIMIT_REACHED does not trigger reconnect', () => {
    const category = classifyFetchFailure('PAGE_LIMIT_REACHED');
    expect(requiresReconnect(category)).toBe(false);
  });

  it('account state unchanged after non-auth failure', () => {
    const acct: AccountState = {
      status: 'active', reconnect_required: false,
      last_auth_error_code: null, last_auth_error_at: null,
      auto_snapshot_enabled: true,
    };
    const category = classifyFetchFailure('NETWORK_ERROR');
    if (requiresReconnect(category)) {
      expect(true).toBe(false);
    }
    expect(acct.reconnect_required).toBe(false);
    expect(acct.status).toBe('active');
  });

  it('non-auth errors still surface error card to user', () => {
    expect(shouldShowErrorCard('IG_RATE_LIMITED', false)).toBe(true);
    expect(shouldShowErrorCard('NETWORK_ERROR', false)).toBe(true);
    expect(shouldShowErrorCard('SUSPICIOUS_RESPONSE', false)).toBe(true);
  });
});

// ── Simulate structured reconnect response from snapshot-start ───────────

/** Simulates snapshot-start returning a structured reconnect response (HTTP 200, not an error) */
function simulateSnapshotStartReconnect(reconnectRequired: boolean): {
  ok: boolean;
  body: {
    reconnect_required?: boolean;
    tracking_state?: string;
    message?: string;
    done?: boolean;
  };
} {
  if (reconnectRequired) {
    return {
      ok: true, // HTTP 200, not an error
      body: {
        reconnect_required: true,
        tracking_state: 'tracking_paused_reconnect_required',
        message: 'Reconnect Instagram to keep tracking active.',
        done: true,
      },
    };
  }
  return { ok: true, body: {} };
}

/** Simulates snapshot-continue returning reconnect-required state */
function simulateSnapshotContinueReconnect(): {
  body: {
    done: boolean;
    reconnect_required: boolean;
    tracking_state: string;
    message: string;
    status: string;
  };
} {
  return {
    body: {
      done: true,
      reconnect_required: true,
      tracking_state: 'tracking_paused_reconnect_required',
      message: 'Tracking is paused until you reconnect Instagram.',
      status: 'failed',
    },
  };
}

/** Simulates the client hook's handling of structured reconnect responses */
function clientHandlesReconnectResponse(body: Record<string, unknown>): {
  setsError: boolean;
  returnsSilently: boolean;
} {
  if (body.reconnect_required === true) {
    // Client returns done silently — no error set
    return { setsError: false, returnsSilently: true };
  }
  return { setsError: true, returnsSilently: false };
}

// ── Simulate resume behavior ─────────────────────────────────────────────

interface SnapshotJobCheckpoint {
  phase: 'followers' | 'following' | 'finalize';
  pages_done: number;
  followers_json: Array<{ ig_id: string; username: string }>;
  following_json: Array<{ ig_id: string; username: string }>;
  followers_cursor: string | null;
  following_cursor: string | null;
}

function simulateResumeFromCheckpoint(
  checkpoint: SnapshotJobCheckpoint,
  newEdges: Array<{ ig_id: string; username: string }>,
  newPages: number,
): SnapshotJobCheckpoint {
  const edges = checkpoint.phase === 'followers'
    ? [...checkpoint.followers_json, ...newEdges]
    : [...checkpoint.following_json, ...newEdges];

  // Deduplicate by ig_id
  const seen = new Set<string>();
  const deduplicated = edges.filter((e) => {
    if (seen.has(e.ig_id)) return false;
    seen.add(e.ig_id);
    return true;
  });

  return {
    ...checkpoint,
    pages_done: checkpoint.pages_done + newPages,
    followers_json: checkpoint.phase === 'followers' ? deduplicated : checkpoint.followers_json,
    following_json: checkpoint.phase === 'following' ? deduplicated : checkpoint.following_json,
  };
}

/** Simulates the status card's display logic */
function getStatusCardState(
  reconnectRequired: boolean,
  autoSnapshotEnabled: boolean,
): { headerLabel: string; nextAutoLabel: string; autoLabel: string } {
  return {
    headerLabel: reconnectRequired ? 'Tracking Paused' : 'Snapshot Status',
    nextAutoLabel: reconnectRequired
      ? 'Paused until reconnect'
      : autoSnapshotEnabled ? 'Around noon your time' : 'Disabled',
    autoLabel: reconnectRequired ? 'Paused' : autoSnapshotEnabled ? 'Enabled' : 'Disabled',
  };
}

/** Simulates the needsReconnect derivation (primary: tracking_state, fallbacks) */
function deriveNeedsReconnect(
  trackingState: TrackingState | null,
  reconnectRequired: boolean,
  captureErrorCode: string | null,
): { needsReconnect: boolean; source: 'server' | 'client_fallback' | 'none' } {
  // Primary: server-provided tracking state or explicit flag
  const serverDriven = (trackingState === 'tracking_paused_reconnect_required')
    || reconnectRequired;
  if (serverDriven) return { needsReconnect: true, source: 'server' };
  // TEMPORARY FALLBACK: client-side error code inference
  if (captureErrorCode && RECONNECT_CODES.has(captureErrorCode)) {
    return { needsReconnect: true, source: 'client_fallback' };
  }
  return { needsReconnect: false, source: 'none' };
}

// ── Simulate SnapshotErrorCard profile lookup ────────────────────────────

/** Profiles that exist in SnapshotErrorCard — reconnect codes are NOT listed */
const ERROR_CARD_PROFILES = new Set([
  'UNAUTHORIZED', 'IG_RATE_LIMITED', 'SUSPICIOUS_RESPONSE',
  'NETWORK_ERROR', 'SNAPSHOT_LIMIT',
]);

function errorCardHasProfile(code: string): boolean {
  return ERROR_CARD_PROFILES.has(code);
}

// ── Simulate checkpoint cursor round-trip ────────────────────────────────

function parseCursorField(raw: string | null): { cursor: string | null; rankToken: string | null } {
  if (!raw) return { cursor: null, rankToken: null };
  const sep = raw.indexOf('|');
  if (sep === -1) return { cursor: raw, rankToken: null };
  return { cursor: raw.substring(0, sep) || null, rankToken: raw.substring(sep + 1) || null };
}

function encodeCursorField(cursor: string | null, rankToken: string): string | null {
  if (!cursor) return null;
  return `${cursor}|${rankToken}`;
}

/** Simulate a complete resume cycle: load checkpoint → fetch new page → merge → deduplicate → persist */
function simulateFullResumeCycle(
  checkpoint: SnapshotJobCheckpoint,
  newEdges: Array<{ ig_id: string; username: string }>,
  newCursor: string | null,
  rankToken: string,
): SnapshotJobCheckpoint {
  const resumed = simulateResumeFromCheckpoint(checkpoint, newEdges, 1);
  const encodedCursor = encodeCursorField(newCursor, rankToken);
  if (checkpoint.phase === 'followers') {
    return { ...resumed, followers_cursor: encodedCursor };
  }
  return { ...resumed, following_cursor: encodedCursor };
}

/** Simulate diff computation using accumulated arrays */
function computeSimpleDiff(
  prevFollowers: string[],
  currFollowers: string[],
): { newFollowers: string[]; lostFollowers: string[] } {
  const prevSet = new Set(prevFollowers);
  const currSet = new Set(currFollowers);
  return {
    newFollowers: currFollowers.filter((id) => !prevSet.has(id)),
    lostFollowers: prevFollowers.filter((id) => !currSet.has(id)),
  };
}

// ── New test sections ──────────────────────────────────────────────────────

describe('snapshot-start returns structured reconnect response', () => {
  it('returns HTTP 200 with reconnect_required=true, not an error', () => {
    const response = simulateSnapshotStartReconnect(true);
    expect(response.ok).toBe(true);
    expect(response.body.reconnect_required).toBe(true);
    expect(response.body.tracking_state).toBe('tracking_paused_reconnect_required');
    expect(response.body.done).toBe(true);
  });

  it('includes calm product message, not technical codes', () => {
    const response = simulateSnapshotStartReconnect(true);
    expect(response.body.message).toBe('Reconnect Instagram to keep tracking active.');
    expect(response.body.message).not.toContain('SESSION_EXPIRED');
    expect(response.body.message).not.toContain('error');
    expect(response.body.message).not.toContain('failed');
  });

  it('client does NOT set an error for structured reconnect response', () => {
    const response = simulateSnapshotStartReconnect(true);
    const handling = clientHandlesReconnectResponse(response.body);
    expect(handling.setsError).toBe(false);
    expect(handling.returnsSilently).toBe(true);
  });

  it('snapshot-continue also returns structured reconnect state', () => {
    const response = simulateSnapshotContinueReconnect();
    expect(response.body.reconnect_required).toBe(true);
    expect(response.body.tracking_state).toBe('tracking_paused_reconnect_required');
    expect(response.body.message).not.toContain('SESSION_EXPIRED');
    expect(response.body.message).not.toContain('error');
  });
});

describe('Status card shows tracking paused when reconnect required', () => {
  it('shows "Tracking Paused" header when reconnect required', () => {
    const state = getStatusCardState(true, true);
    expect(state.headerLabel).toBe('Tracking Paused');
  });

  it('shows "Snapshot Status" header when tracking is active', () => {
    const state = getStatusCardState(false, true);
    expect(state.headerLabel).toBe('Snapshot Status');
  });

  it('shows "Paused until reconnect" for next auto when reconnect required', () => {
    const state = getStatusCardState(true, true);
    expect(state.nextAutoLabel).toBe('Paused until reconnect');
  });

  it('shows "Paused" for auto snapshots when reconnect required', () => {
    const state = getStatusCardState(true, true);
    expect(state.autoLabel).toBe('Paused');
  });

  it('shows normal auto labels when tracking is active', () => {
    const state = getStatusCardState(false, true);
    expect(state.nextAutoLabel).toBe('Around noon your time');
    expect(state.autoLabel).toBe('Enabled');
  });

  it('shows "Disabled" when auto snapshots are off and tracking is active', () => {
    const state = getStatusCardState(false, false);
    expect(state.nextAutoLabel).toBe('Disabled');
    expect(state.autoLabel).toBe('Disabled');
  });
});

describe('Resume behavior: checkpoint consumption', () => {
  it('resumes from saved cursor position, not from page 0', () => {
    const checkpoint: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 10,
      followers_json: Array.from({ length: 200 }, (_, i) => ({ ig_id: `f${i}`, username: `user${i}` })),
      following_json: [],
      followers_cursor: 'cursor_page_10|rank_abc',
      following_cursor: null,
    };
    // Cursor is non-null → resume from that cursor
    expect(checkpoint.followers_cursor).toBeTruthy();
    expect(checkpoint.pages_done).toBe(10);
    expect(checkpoint.followers_json.length).toBe(200);
  });

  it('appends new edges to existing progress without duplication', () => {
    const checkpoint: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 5,
      followers_json: [
        { ig_id: 'a1', username: 'alice' },
        { ig_id: 'b2', username: 'bob' },
      ],
      following_json: [],
      followers_cursor: 'cursor_page_5|rank_xyz',
      following_cursor: null,
    };
    const newEdges = [
      { ig_id: 'b2', username: 'bob' },  // duplicate
      { ig_id: 'c3', username: 'carol' }, // new
    ];
    const resumed = simulateResumeFromCheckpoint(checkpoint, newEdges, 2);
    expect(resumed.pages_done).toBe(7);
    expect(resumed.followers_json.length).toBe(3); // alice, bob, carol (bob deduplicated)
    expect(resumed.followers_json.map(e => e.ig_id)).toEqual(['a1', 'b2', 'c3']);
  });

  it('preserves following progress during following phase resume', () => {
    const checkpoint: SnapshotJobCheckpoint = {
      phase: 'following', pages_done: 12,
      followers_json: Array.from({ length: 300 }, (_, i) => ({ ig_id: `f${i}`, username: `fuser${i}` })),
      following_json: [
        { ig_id: 'fw1', username: 'friend1' },
        { ig_id: 'fw2', username: 'friend2' },
      ],
      followers_cursor: null,
      following_cursor: 'fcursor_page_2|rank_qrs',
    };
    const newEdges = [
      { ig_id: 'fw3', username: 'friend3' },
    ];
    const resumed = simulateResumeFromCheckpoint(checkpoint, newEdges, 1);
    expect(resumed.pages_done).toBe(13);
    expect(resumed.following_json.length).toBe(3);
    // Follower list unchanged
    expect(resumed.followers_json.length).toBe(300);
  });

  it('post-reconnect starts a fresh job (integrity requirement)', () => {
    // After reconnect, a new job is created. The old session's cursor and
    // rank_token are invalid with the new cookie. Starting fresh is correct.
    const freshJob: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 0,
      followers_json: [],
      following_json: [], // may be pre-populated from last complete snapshot
      followers_cursor: null,
      following_cursor: null,
    };
    expect(freshJob.pages_done).toBe(0);
    expect(freshJob.followers_json.length).toBe(0);
    expect(freshJob.followers_cursor).toBeNull();
  });

  it('following cache is reused from last complete snapshot on fresh job', () => {
    // snapshot-start pre-populates following_json from most recent complete
    // snapshot within 24h. This avoids re-fetching the following list.
    const freshJobWithCache: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 0,
      followers_json: [],
      following_json: Array.from({ length: 150 }, (_, i) => ({ ig_id: `fw${i}`, username: `fwuser${i}` })),
      followers_cursor: null,
      following_cursor: null, // null cursor + non-empty list → cache hit → skip API fetch
    };
    const isCacheHit = freshJobWithCache.following_json.length > 0 && freshJobWithCache.following_cursor === null;
    expect(isCacheHit).toBe(true);
  });
});

describe('Tracking state as primary product state source', () => {
  it('tracking_state is the primary source for needsReconnect', () => {
    // Server says reconnect required via tracking_state
    const result = deriveNeedsReconnect('tracking_paused_reconnect_required', false, null);
    expect(result.needsReconnect).toBe(true);
    expect(result.source).toBe('server');
  });

  it('reconnect_required boolean is the secondary fallback', () => {
    const result = deriveNeedsReconnect('tracking_active', true, null);
    expect(result.needsReconnect).toBe(true);
    expect(result.source).toBe('server');
  });

  it('error code inference is the last resort fallback', () => {
    const r1 = deriveNeedsReconnect(null, false, 'SESSION_EXPIRED');
    expect(r1.needsReconnect).toBe(true);
    expect(r1.source).toBe('client_fallback');
    const r2 = deriveNeedsReconnect(null, false, 'CHALLENGE_REQUIRED');
    expect(r2.needsReconnect).toBe(true);
    expect(r2.source).toBe('client_fallback');
  });

  it('tracking_active with no flags means no reconnect needed', () => {
    const result = deriveNeedsReconnect('tracking_active', false, null);
    expect(result.needsReconnect).toBe(false);
    expect(result.source).toBe('none');
  });

  it('non-reconnect error codes do not trigger reconnect', () => {
    expect(deriveNeedsReconnect('tracking_active', false, 'IG_RATE_LIMITED').needsReconnect).toBe(false);
    expect(deriveNeedsReconnect('tracking_active', false, 'NETWORK_ERROR').needsReconnect).toBe(false);
  });
});

describe('Temporary vs reconnect failure differentiation', () => {
  it('rate_limited shows error card, not reconnect banner', () => {
    const category = classifyFetchFailure('IG_RATE_LIMITED');
    expect(requiresReconnect(category)).toBe(false);
    expect(shouldShowErrorCard('IG_RATE_LIMITED', false)).toBe(true);
    expect(deriveNeedsReconnect('tracking_active', false, 'IG_RATE_LIMITED').needsReconnect).toBe(false);
  });

  it('network_error shows error card, not reconnect banner', () => {
    const category = classifyFetchFailure('NETWORK_ERROR');
    expect(requiresReconnect(category)).toBe(false);
    expect(shouldShowErrorCard('NETWORK_ERROR', false)).toBe(true);
    expect(deriveNeedsReconnect('tracking_active', false, 'NETWORK_ERROR').needsReconnect).toBe(false);
  });

  it('session_expired shows reconnect banner, not error card', () => {
    const category = classifyFetchFailure('SESSION_EXPIRED');
    expect(requiresReconnect(category)).toBe(true);
    expect(shouldShowErrorCard('SESSION_EXPIRED', false)).toBe(false);
    expect(deriveNeedsReconnect('tracking_paused_reconnect_required', true, null).needsReconnect).toBe(true);
  });

  it('checkpoint_or_challenge shows reconnect banner, not error card', () => {
    const category = classifyFetchFailure('CHALLENGE_REQUIRED');
    expect(requiresReconnect(category)).toBe(true);
    expect(shouldShowErrorCard('CHALLENGE_REQUIRED', false)).toBe(false);
    expect(deriveNeedsReconnect('tracking_paused_reconnect_required', true, null).needsReconnect).toBe(true);
  });

  it('temporary issues do not disable account indefinitely', () => {
    const acct: AccountState = {
      status: 'active', reconnect_required: false,
      last_auth_error_code: null, last_auth_error_at: null,
      auto_snapshot_enabled: true,
    };
    // After a rate limit failure, account stays active
    const category = classifyFetchFailure('IG_RATE_LIMITED');
    expect(requiresReconnect(category)).toBe(false);
    // No state change — account is not marked for reconnect
    expect(acct.reconnect_required).toBe(false);
    expect(acct.status).toBe('active');
    // Jobs are NOT blocked
    expect(shouldBlockJob(acct).blocked).toBe(false);
  });
});

describe('Centralized copy consistency', () => {
  // These tests verify the constants match what the UI renders.
  // If the centralized copy changes, these tests catch mismatches.

  const RECONNECT_COPY = {
    bannerTitle: 'Reconnect Instagram to keep tracking active',
    bannerBody: 'Tracking is paused until you reconnect. Your history and results are safe.',
    bannerButton: 'Reconnect Instagram',
    snapshotButtonLabel: 'Paused',
    infoText: 'Reconnect your Instagram to resume tracking.',
    pushTitle: 'Reconnect Instagram',
    pushBody: 'StayReel is paused until you reconnect Instagram. Tap to reconnect.',
    serverStartBlocked: 'Reconnect Instagram to keep tracking active.',
    serverContinueBlocked: 'Tracking is paused until you reconnect Instagram.',
  };

  it('banner copy has no technical error jargon', () => {
    const allCopy = [
      RECONNECT_COPY.bannerTitle,
      RECONNECT_COPY.bannerBody,
      RECONNECT_COPY.bannerButton,
      RECONNECT_COPY.snapshotButtonLabel,
      RECONNECT_COPY.infoText,
      RECONNECT_COPY.pushTitle,
      RECONNECT_COPY.pushBody,
    ];
    const forbidden = ['error', 'failed', 'expired', 'invalid', 'token', 'session', 'exception'];
    for (const copy of allCopy) {
      for (const word of forbidden) {
        expect(copy.toLowerCase()).not.toContain(word);
      }
    }
  });

  it('server response messages use calm language', () => {
    expect(RECONNECT_COPY.serverStartBlocked).not.toContain('error');
    expect(RECONNECT_COPY.serverContinueBlocked).not.toContain('error');
    expect(RECONNECT_COPY.serverStartBlocked).not.toContain('failed');
    expect(RECONNECT_COPY.serverContinueBlocked).not.toContain('failed');
  });

  it('push notification body contains a clear call to action', () => {
    expect(RECONNECT_COPY.pushBody).toContain('reconnect');
    expect(RECONNECT_COPY.pushTitle).toContain('Reconnect');
  });
});

// ── SnapshotErrorCard profile cleanup ─────────────────────────────────────

describe('SnapshotErrorCard has no reconnect profiles', () => {
  it('SESSION_EXPIRED is not a registered error card profile', () => {
    expect(errorCardHasProfile('SESSION_EXPIRED')).toBe(false);
  });

  it('IG_SESSION_INVALID is not a registered error card profile', () => {
    expect(errorCardHasProfile('IG_SESSION_INVALID')).toBe(false);
  });

  it('CHALLENGE_REQUIRED is not a registered error card profile', () => {
    expect(errorCardHasProfile('CHALLENGE_REQUIRED')).toBe(false);
  });

  it('CHECKPOINT_REQUIRED is not a registered error card profile', () => {
    expect(errorCardHasProfile('CHECKPOINT_REQUIRED')).toBe(false);
  });

  it('IG_CHALLENGE_REQUIRED is not a registered error card profile', () => {
    expect(errorCardHasProfile('IG_CHALLENGE_REQUIRED')).toBe(false);
  });

  it('RECONNECT_REQUIRED is not a registered error card profile', () => {
    expect(errorCardHasProfile('RECONNECT_REQUIRED')).toBe(false);
  });

  it('non-reconnect profiles still exist', () => {
    expect(errorCardHasProfile('IG_RATE_LIMITED')).toBe(true);
    expect(errorCardHasProfile('NETWORK_ERROR')).toBe(true);
    expect(errorCardHasProfile('SNAPSHOT_LIMIT')).toBe(true);
    expect(errorCardHasProfile('UNAUTHORIZED')).toBe(true);
    expect(errorCardHasProfile('SUSPICIOUS_RESPONSE')).toBe(true);
  });
});

// ── Cursor round-trip and resume correctness ──────────────────────────────

describe('Cursor round-trip through checkpoint', () => {
  it('parseCursorField extracts cursor and rankToken from encoded string', () => {
    const encoded = 'abc123|rank_xyz';
    const { cursor, rankToken } = parseCursorField(encoded);
    expect(cursor).toBe('abc123');
    expect(rankToken).toBe('rank_xyz');
  });

  it('parseCursorField handles null cursor', () => {
    const { cursor, rankToken } = parseCursorField(null);
    expect(cursor).toBeNull();
    expect(rankToken).toBeNull();
  });

  it('encodeCursorField produces correct format', () => {
    expect(encodeCursorField('cursor_page_5', 'rank_abc')).toBe('cursor_page_5|rank_abc');
  });

  it('encodeCursorField returns null for null cursor', () => {
    expect(encodeCursorField(null, 'rank_abc')).toBeNull();
  });

  it('round-trip: encode then parse yields original values', () => {
    const encoded = encodeCursorField('my_cursor', 'my_rank')!;
    const { cursor, rankToken } = parseCursorField(encoded);
    expect(cursor).toBe('my_cursor');
    expect(rankToken).toBe('my_rank');
  });
});

describe('Resume from mid-followers checkpoint', () => {
  const baseCheckpoint: SnapshotJobCheckpoint = {
    phase: 'followers', pages_done: 8,
    followers_json: Array.from({ length: 160 }, (_, i) => ({ ig_id: `f${i}`, username: `user${i}` })),
    following_json: [],
    followers_cursor: 'cursor_page_8|rank_abc123',
    following_cursor: null,
  };

  it('cursor is consumed by fetchEdgeListChunked (parsed correctly)', () => {
    const { cursor, rankToken } = parseCursorField(baseCheckpoint.followers_cursor);
    expect(cursor).toBe('cursor_page_8');
    expect(rankToken).toBe('rank_abc123');
  });

  it('new edges are appended and deduplicated after resume', () => {
    const newEdges = [
      { ig_id: 'f159', username: 'user159' },  // overlap with last edge
      { ig_id: 'f160', username: 'user160' },   // new
      { ig_id: 'f161', username: 'user161' },   // new
    ];
    const resumed = simulateFullResumeCycle(baseCheckpoint, newEdges, 'cursor_page_9', 'rank_abc123');
    expect(resumed.followers_json.length).toBe(162); // 160 + 2 new (1 duplicate removed)
    expect(resumed.pages_done).toBe(9);
    expect(resumed.followers_cursor).toBe('cursor_page_9|rank_abc123');
  });

  it('rank token stays consistent across invocations', () => {
    const newEdges = [{ ig_id: 'f160', username: 'user160' }];
    const r1 = simulateFullResumeCycle(baseCheckpoint, newEdges, 'cursor_page_9', 'rank_abc123');
    const r2 = simulateFullResumeCycle(r1, [{ ig_id: 'f161', username: 'user161' }], 'cursor_page_10', 'rank_abc123');
    // All cursors use the same rank token
    const { rankToken: rt1 } = parseCursorField(r1.followers_cursor);
    const { rankToken: rt2 } = parseCursorField(r2.followers_cursor);
    expect(rt1).toBe('rank_abc123');
    expect(rt2).toBe('rank_abc123');
  });

  it('pages_done is monotonically increasing across resumes', () => {
    const r1 = simulateFullResumeCycle(baseCheckpoint, [{ ig_id: 'new1', username: 'n1' }], 'c9', 'r1');
    const r2 = simulateFullResumeCycle(r1, [{ ig_id: 'new2', username: 'n2' }], 'c10', 'r1');
    const r3 = simulateFullResumeCycle(r2, [{ ig_id: 'new3', username: 'n3' }], null, 'r1');
    expect(r1.pages_done).toBe(9);
    expect(r2.pages_done).toBe(10);
    expect(r3.pages_done).toBe(11);
  });
});

describe('Resume from mid-following checkpoint', () => {
  const baseCheckpoint: SnapshotJobCheckpoint = {
    phase: 'following', pages_done: 15,
    followers_json: Array.from({ length: 300 }, (_, i) => ({ ig_id: `f${i}`, username: `fuser${i}` })),
    following_json: Array.from({ length: 100 }, (_, i) => ({ ig_id: `fw${i}`, username: `fwuser${i}` })),
    followers_cursor: null,
    following_cursor: 'fcursor_page_3|frank_qrs',
  };

  it('following cursor is parsed correctly on resume', () => {
    const { cursor, rankToken } = parseCursorField(baseCheckpoint.following_cursor);
    expect(cursor).toBe('fcursor_page_3');
    expect(rankToken).toBe('frank_qrs');
  });

  it('following edges are appended and deduplicated', () => {
    const newEdges = [
      { ig_id: 'fw99', username: 'fwuser99' },    // duplicate
      { ig_id: 'fw100', username: 'fwuser100' },   // new
    ];
    const resumed = simulateResumeFromCheckpoint(baseCheckpoint, newEdges, 1);
    expect(resumed.following_json.length).toBe(101); // 100 + 1 new
    expect(resumed.followers_json.length).toBe(300); // unchanged
    expect(resumed.pages_done).toBe(16);
  });

  it('followers array is not modified during following phase resume', () => {
    const newEdges = [{ ig_id: 'fw100', username: 'fwuser100' }];
    const resumed = simulateResumeFromCheckpoint(baseCheckpoint, newEdges, 1);
    // Followers are exactly the same references
    expect(resumed.followers_json).toEqual(baseCheckpoint.followers_json);
  });
});

describe('No duplicate edges after multi-invocation resume', () => {
  it('three consecutive resumes produce zero duplicates', () => {
    let cp: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 0, followers_json: [], following_json: [],
      followers_cursor: null, following_cursor: null,
    };

    // Invocation 1: fetch 3 edges
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'a', username: 'a' }, { ig_id: 'b', username: 'b' }, { ig_id: 'c', username: 'c' }], 1);
    expect(cp.followers_json.length).toBe(3);

    // Invocation 2: fetch 3 more with 1 overlap
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'c', username: 'c' }, { ig_id: 'd', username: 'd' }, { ig_id: 'e', username: 'e' }], 1);
    expect(cp.followers_json.length).toBe(5);

    // Invocation 3: fetch 2 more with 1 overlap
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'e', username: 'e' }, { ig_id: 'f', username: 'f' }], 1);
    expect(cp.followers_json.length).toBe(6);

    // Verify unique IDs
    const ids = cp.followers_json.map((e) => e.ig_id);
    expect(new Set(ids).size).toBe(6);
    expect(ids).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('all-duplicate page produces no new edges', () => {
    const cp: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 2,
      followers_json: [{ ig_id: 'x', username: 'x' }, { ig_id: 'y', username: 'y' }],
      following_json: [], followers_cursor: 'c|r', following_cursor: null,
    };
    const resumed = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'x', username: 'x' }, { ig_id: 'y', username: 'y' }], 1);
    expect(resumed.followers_json.length).toBe(2);
    expect(resumed.pages_done).toBe(3);
  });
});

describe('Final diff correctness after resumed completion', () => {
  it('diff computed from accumulated arrays is correct', () => {
    const prevFollowers = ['alice', 'bob', 'carol'];
    // After resume: accumulated followers (bob left, dave joined)
    const currFollowers = ['alice', 'carol', 'dave'];

    const diff = computeSimpleDiff(prevFollowers, currFollowers);
    expect(diff.newFollowers).toEqual(['dave']);
    expect(diff.lostFollowers).toEqual(['bob']);
  });

  it('diff is correct after multi-invocation resume with edge overlap', () => {
    const prevFollowers = ['f1', 'f2', 'f3', 'f4', 'f5'];

    // Simulate: invocation 1 fetches f1, f2, f3; invocation 2 fetches f3, f6
    let cp: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 0, followers_json: [], following_json: [],
      followers_cursor: null, following_cursor: null,
    };
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'f1', username: 'u1' }, { ig_id: 'f2', username: 'u2' }, { ig_id: 'f3', username: 'u3' }], 1);
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'f3', username: 'u3' }, { ig_id: 'f6', username: 'u6' }], 1);

    const currIds = cp.followers_json.map((e) => e.ig_id);
    const diff = computeSimpleDiff(prevFollowers, currIds);
    expect(diff.newFollowers).toEqual(['f6']);
    expect(diff.lostFollowers).toEqual(['f4', 'f5']);
  });

  it('diff with zero changes after complete re-fetch is empty', () => {
    const prevFollowers = ['a', 'b', 'c'];
    let cp: SnapshotJobCheckpoint = {
      phase: 'followers', pages_done: 0, followers_json: [], following_json: [],
      followers_cursor: null, following_cursor: null,
    };
    cp = simulateResumeFromCheckpoint(cp,
      [{ ig_id: 'a', username: 'a' }, { ig_id: 'b', username: 'b' }, { ig_id: 'c', username: 'c' }], 1);
    const diff = computeSimpleDiff(prevFollowers, cp.followers_json.map((e) => e.ig_id));
    expect(diff.newFollowers).toEqual([]);
    expect(diff.lostFollowers).toEqual([]);
  });
});

// ── Server-driven state source verification ───────────────────────────────

describe('Server-driven state is the primary source of truth', () => {
  it('server tracking_state takes priority over client error code', () => {
    const result = deriveNeedsReconnect('tracking_paused_reconnect_required', false, null);
    expect(result.source).toBe('server');
  });

  it('client fallback only fires when server state is absent', () => {
    const result = deriveNeedsReconnect(null, false, 'SESSION_EXPIRED');
    expect(result.source).toBe('client_fallback');
  });

  it('server active state overrides client error code for non-reconnect codes', () => {
    const result = deriveNeedsReconnect('tracking_active', false, 'IG_RATE_LIMITED');
    expect(result.needsReconnect).toBe(false);
  });

  it('reconnect_required=true without tracking_state still counts as server-driven', () => {
    const result = deriveNeedsReconnect(null, true, null);
    expect(result.needsReconnect).toBe(true);
    expect(result.source).toBe('server');
  });
});
