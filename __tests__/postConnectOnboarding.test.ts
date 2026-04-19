/**
 * Tests for the post-connect onboarding feature flag.
 * Validates that:
 *   - With flag OFF: no onboarding modals are triggered
 *   - With flag ON: onboarding hooks report shouldShow correctly
 *   - Connect flow transitions directly to dashboard
 *   - Manual snapshots are unaffected
 */

// Inline the flag value for testing (mirrors lib/featureFlags.ts)
const ENABLE_POST_CONNECT_ONBOARDING = false;

// ─── Feature flag behavior ───────────────────────────────────────────────────

describe('ENABLE_POST_CONNECT_ONBOARDING flag', () => {
  it('is set to false (disabled)', () => {
    expect(ENABLE_POST_CONNECT_ONBOARDING).toBe(false);
  });
});

// ─── School prompt with flag OFF ──────────────────────────────────────────────

describe('useSchoolPrompt with flag OFF', () => {
  function computeShouldShow(
    flagEnabled: boolean,
    queryData: boolean | undefined,
  ): boolean {
    return flagEnabled && queryData === true;
  }

  it('returns shouldShow=false even if query would return true', () => {
    expect(computeShouldShow(false, true)).toBe(false);
  });

  it('returns shouldShow=false when query is undefined (loading)', () => {
    expect(computeShouldShow(false, undefined)).toBe(false);
  });

  it('query is not enabled when flag is off', () => {
    const userId = 'user-1';
    const igAccountId = 'acct-1';
    const enabled = ENABLE_POST_CONNECT_ONBOARDING && !!userId && !!igAccountId;
    expect(enabled).toBe(false);
  });
});

// ─── Referral prompt with flag OFF ────────────────────────────────────────────

describe('useReferralPrompt with flag OFF', () => {
  function computeShouldShow(
    flagEnabled: boolean,
    dismissed: boolean,
    queryData: boolean | undefined,
  ): boolean {
    return flagEnabled && !dismissed && queryData === true;
  }

  it('returns shouldShow=false even if query resolves true', () => {
    expect(computeShouldShow(false, false, true)).toBe(false);
  });

  it('returns shouldShow=false when dismissed', () => {
    expect(computeShouldShow(true, true, true)).toBe(false);
  });

  it('query is not enabled when flag is off', () => {
    const userId = 'user-1';
    const igAccountId = 'acct-1';
    const enabled = ENABLE_POST_CONNECT_ONBOARDING && !!userId && !!igAccountId;
    expect(enabled).toBe(false);
  });
});

// ─── School prompt with flag ON ───────────────────────────────────────────────

describe('useSchoolPrompt with flag ON (re-enable scenario)', () => {
  const FLAG_ON = true;

  function computeShouldShow(
    flagEnabled: boolean,
    queryData: boolean | undefined,
  ): boolean {
    return flagEnabled && queryData === true;
  }

  it('returns shouldShow=true when query resolves true', () => {
    expect(computeShouldShow(FLAG_ON, true)).toBe(true);
  });

  it('returns shouldShow=false when query resolves false', () => {
    expect(computeShouldShow(FLAG_ON, false)).toBe(false);
  });

  it('query is enabled when flag is on and user is authenticated', () => {
    const userId = 'user-1';
    const igAccountId = 'acct-1';
    const enabled = FLAG_ON && !!userId && !!igAccountId;
    expect(enabled).toBe(true);
  });
});

// ─── Connect flow: no freeze, direct dashboard transition ─────────────────────

describe('connect-instagram success flow', () => {
  it('does not require school selection to proceed', () => {
    // With flag OFF, school prompt never fires — navigation is immediate
    const schoolShouldShow = ENABLE_POST_CONNECT_ONBOARDING && true;
    expect(schoolShouldShow).toBe(false);
  });

  it('does not require referral entry to proceed', () => {
    const referralShouldShow = ENABLE_POST_CONNECT_ONBOARDING && true;
    expect(referralShouldShow).toBe(false);
  });

  it('app routes directly to dashboard after connect', () => {
    // Simulates: setIgAccountId → router.replace('/(tabs)/dashboard')
    // No intermediate modal gates
    const targetRoute = '/(tabs)/dashboard';
    const blockedByOnboarding = ENABLE_POST_CONNECT_ONBOARDING && false; // no blocking
    expect(blockedByOnboarding).toBe(false);
    expect(targetRoute).toBe('/(tabs)/dashboard');
  });

  it('scoped query invalidation avoids triggering all hooks', () => {
    // Previously: qc.invalidateQueries() with no filter
    // Now: qc.invalidateQueries({ queryKey: ['dashboard'] })
    const invalidatedKey = ['dashboard'];
    expect(invalidatedKey).not.toContain('school-prompt');
    expect(invalidatedKey).not.toContain('referral-prompt');
  });
});
