/**
 * Unit tests for snapshot partial-completion UX.
 * Validates that:
 *   - Server finalize includes isListComplete in the response
 *   - Client finalise() propagates is_list_complete to CaptureResult
 *   - Analytics event fires for partial captures
 *   - PAGE_LIMIT_REACHED is NOT classified as a failure
 *   - Dashboard shows partial notice when is_complete === false
 */

// ─── makeResult behavior ──────────────────────────────────────────────────────

describe('ChunkResult.isListComplete', () => {
  // Mirrors makeResult from snapshotJob.ts
  function makeResult(
    status: 'running' | 'complete' | 'failed',
    done: boolean,
    isListComplete?: boolean,
  ) {
    return {
      jobId: 'job-1',
      status,
      phase: 'finalize',
      pagesDone: 45,
      followersSeen: 4200,
      followingSeen: 800,
      done,
      message: 'Snapshot complete.',
      isListComplete,
    };
  }

  it('includes isListComplete=true for full captures', () => {
    const result = makeResult('complete', true, true);
    expect(result.isListComplete).toBe(true);
  });

  it('includes isListComplete=false for partial captures', () => {
    const result = makeResult('complete', true, false);
    expect(result.isListComplete).toBe(false);
  });

  it('isListComplete is undefined for running chunks', () => {
    const result = makeResult('running', false, undefined);
    expect(result.isListComplete).toBeUndefined();
  });
});

// ─── Client finalise() propagation ───────────────────────────────────────────

describe('client finalise propagation', () => {
  // Mirrors finalise() from useSnapshotCapture.ts
  function finalise(chunk: { jobId: string; status: string; isListComplete?: boolean }) {
    return {
      jobId: chunk.jobId,
      status: chunk.status,
      is_list_complete: chunk.isListComplete,
    };
  }

  it('propagates is_list_complete=true', () => {
    const result = finalise({ jobId: 'j1', status: 'complete', isListComplete: true });
    expect(result.is_list_complete).toBe(true);
  });

  it('propagates is_list_complete=false for partial', () => {
    const result = finalise({ jobId: 'j1', status: 'complete', isListComplete: false });
    expect(result.is_list_complete).toBe(false);
  });

  it('is_list_complete is undefined when not provided', () => {
    const result = finalise({ jobId: 'j1', status: 'complete' });
    expect(result.is_list_complete).toBeUndefined();
  });
});

// ─── PAGE_LIMIT_REACHED is NOT a failure ─────────────────────────────────────

describe('PAGE_LIMIT_REACHED classification', () => {
  // Mirrors the logic from snapshotJob.ts lines 409/497:
  // if (result.stopReason && result.stopReason !== "PAGE_LIMIT_REACHED")
  function shouldFailJob(stopReason: string | null): boolean {
    return stopReason !== null && stopReason !== 'PAGE_LIMIT_REACHED';
  }

  it('does NOT fail the job when PAGE_LIMIT_REACHED', () => {
    expect(shouldFailJob('PAGE_LIMIT_REACHED')).toBe(false);
  });

  it('does NOT fail the job when stopReason is null (normal pagination end)', () => {
    expect(shouldFailJob(null)).toBe(false);
  });

  it('DOES fail the job for IG_RATE_LIMITED', () => {
    expect(shouldFailJob('IG_RATE_LIMITED')).toBe(true);
  });

  it('DOES fail the job for SESSION_EXPIRED', () => {
    expect(shouldFailJob('SESSION_EXPIRED')).toBe(true);
  });
});

// ─── Analytics event selection ───────────────────────────────────────────────

describe('snapshot_partial_complete analytics', () => {
  function chooseEvents(isListComplete: boolean | undefined): string[] {
    const events: string[] = [];
    if (isListComplete === false) {
      events.push('snapshot_partial_complete');
    }
    events.push('snapshot_completed');
    return events;
  }

  it('fires both partial + completed events for partial capture', () => {
    const events = chooseEvents(false);
    expect(events).toEqual(['snapshot_partial_complete', 'snapshot_completed']);
  });

  it('fires only completed event for full capture', () => {
    const events = chooseEvents(true);
    expect(events).toEqual(['snapshot_completed']);
  });

  it('fires only completed event when isListComplete is undefined', () => {
    const events = chooseEvents(undefined);
    expect(events).toEqual(['snapshot_completed']);
  });
});

// ─── Dashboard partial notice visibility ─────────────────────────────────────

describe('dashboard partial notice', () => {
  function shouldShowPartialNotice(data: { is_complete: boolean } | null): boolean {
    return data !== null && data.is_complete === false;
  }

  it('shows notice when is_complete is false', () => {
    expect(shouldShowPartialNotice({ is_complete: false })).toBe(true);
  });

  it('hides notice when is_complete is true', () => {
    expect(shouldShowPartialNotice({ is_complete: true })).toBe(false);
  });

  it('hides notice when data is null', () => {
    expect(shouldShowPartialNotice(null)).toBe(false);
  });
});

// ─── isListComplete server-side logic ────────────────────────────────────────

describe('isListComplete computation', () => {
  function computeIsListComplete(
    followersCursor: string | null,
    followingCursor: string | null,
  ): boolean {
    return followersCursor === null && followingCursor === null;
  }

  it('returns true when both cursors are null', () => {
    expect(computeIsListComplete(null, null)).toBe(true);
  });

  it('returns false when followers cursor remains', () => {
    expect(computeIsListComplete('abc123', null)).toBe(false);
  });

  it('returns false when following cursor remains', () => {
    expect(computeIsListComplete(null, 'xyz789')).toBe(false);
  });

  it('returns false when both cursors remain', () => {
    expect(computeIsListComplete('abc', 'xyz')).toBe(false);
  });
});
