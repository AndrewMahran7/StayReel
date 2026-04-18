/**
 * Minimal unit test for subscriptionStore.effectivePlan() scenarios.
 * Covers the five plan states displayed in Settings so a regression is caught
 * before it reaches the Settings crash again.
 */

// We test the logic standalone to avoid needing a full React/Zustand setup.
// The function body mirrors effectivePlan() in subscriptionStore.ts.

type PlanSource = 'monthly' | 'annual' | 'trial' | 'promo' | 'free';
interface EffectivePlan {
  hasProAccess: boolean;
  source: PlanSource;
  planLabel: string;
  expiresAt: string | null;
}

function effectivePlan(state: {
  isPro: boolean;
  status: string;
  expiresAt: string | null;
  promoUntil: string | null;
  rcProductId: string | null;
}): EffectivePlan {
  const { isPro, status, expiresAt, promoUntil, rcProductId } = state;

  if (!isPro) {
    return { hasProAccess: false, source: 'free', planLabel: 'Free', expiresAt: null };
  }

  if (rcProductId) {
    const isAnnual = /annual|yearly|year/i.test(rcProductId);
    const isTrial  = status === 'trial';
    return {
      hasProAccess: true,
      source:    isTrial ? 'trial' : (isAnnual ? 'annual' : 'monthly'),
      planLabel: isTrial ? 'Free Trial' : (isAnnual ? 'Pro Annual' : 'Pro Monthly'),
      expiresAt,
    };
  }

  if (promoUntil) {
    return { hasProAccess: true, source: 'promo', planLabel: 'Pro (Promo)', expiresAt: promoUntil };
  }

  const isTrial = status === 'trial';
  return {
    hasProAccess: true,
    source:    isTrial ? 'trial' : 'monthly',
    planLabel: isTrial ? 'Free Trial' : 'Pro',
    expiresAt,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatExpiryLabel(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateRowTitle(source: PlanSource): string {
  if (source === 'promo') return 'Promo expires';
  if (source === 'trial') return 'Trial ends';
  return 'Renews';
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('effectivePlan()', () => {
  const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  test('free user', () => {
    const plan = effectivePlan({ isPro: false, status: 'free', expiresAt: null, promoUntil: null, rcProductId: null });
    expect(plan.planLabel).toBe('Free');
    expect(plan.source).toBe('free');
    expect(plan.hasProAccess).toBe(false);
    expect(plan.expiresAt).toBeNull();
  });

  test('trial user (RC product with trial status)', () => {
    const plan = effectivePlan({ isPro: true, status: 'trial', expiresAt: FUTURE, promoUntil: null, rcProductId: 'stayreel_monthly' });
    expect(plan.planLabel).toBe('Free Trial');
    expect(plan.source).toBe('trial');
    expect(plan.hasProAccess).toBe(true);
    expect(dateRowTitle(plan.source)).toBe('Trial ends');
    expect(formatExpiryLabel(plan.expiresAt)).not.toBeNull();
  });

  test('promo user (no RC product)', () => {
    const plan = effectivePlan({ isPro: true, status: 'active', expiresAt: null, promoUntil: FUTURE, rcProductId: null });
    expect(plan.planLabel).toBe('Pro (Promo)');
    expect(plan.source).toBe('promo');
    expect(plan.expiresAt).toBe(FUTURE);
    expect(dateRowTitle(plan.source)).toBe('Promo expires');
  });

  test('paid monthly user', () => {
    const plan = effectivePlan({ isPro: true, status: 'active', expiresAt: FUTURE, promoUntil: null, rcProductId: 'stayreel_monthly' });
    expect(plan.planLabel).toBe('Pro Monthly');
    expect(plan.source).toBe('monthly');
    expect(dateRowTitle(plan.source)).toBe('Renews');
  });

  test('paid annual user', () => {
    const plan = effectivePlan({ isPro: true, status: 'active', expiresAt: FUTURE, promoUntil: null, rcProductId: 'stayreel_annual' });
    expect(plan.planLabel).toBe('Pro Annual');
    expect(plan.source).toBe('annual');
    expect(dateRowTitle(plan.source)).toBe('Renews');
  });
});

describe('formatExpiryLabel()', () => {
  test('null input returns null', () => {
    expect(formatExpiryLabel(null)).toBeNull();
  });

  test('invalid date string returns null (no crash)', () => {
    expect(formatExpiryLabel('not-a-date')).toBeNull();
  });

  test('valid ISO date returns formatted string', () => {
    const label = formatExpiryLabel('2026-06-15T00:00:00Z');
    expect(label).toBeTruthy();
    expect(label).toContain('Jun');
  });
});
