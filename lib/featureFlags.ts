// lib/featureFlags.ts
// Centralized feature flags for StayReel.
// Toggle features without deleting underlying logic or DB fields.

/**
 * When false, disables the post-connect onboarding flow:
 *   - School picker modal (dashboard + tabs layout)
 *   - Referral code prompt modal (tabs layout)
 *
 * The underlying hooks, DB columns, and Settings entries remain intact
 * so the flow can be re-enabled by flipping this to true.
 */
export const ENABLE_POST_CONNECT_ONBOARDING = false;
