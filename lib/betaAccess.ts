// lib/betaAccess.ts
// Central beta-access flag. Flip BETA_ACCESS_ENABLED to false to
// re-enable normal monetisation. This is the ONLY switch you need.
//
// See BETA_ACCESS.md for full documentation on how this interacts
// with RevenueCat, promo codes, and server-side gating.

/** Master switch — set to `false` to end the beta and restore paywalls. */
const BETA_ACCESS_ENABLED = true;

/** Returns true while the beta promotion is active. */
export function isBetaActive(): boolean {
  return BETA_ACCESS_ENABLED;
}
