// lib/limitsCopy.ts
// Centralized user-facing copy about account size expectations.
// All messaging uses consistent wording and the ~5,000 threshold.

export const LIMITS_COPY = {
  /** Subtle one-liner shown during onboarding (connect-instagram screen). */
  onboarding: 'Best experience with accounts under ~5,000 followers.',

  /** Shown on dashboard when the latest snapshot has is_complete === false. */
  partialResults: {
    headline:
      'We reached the current scan limit before finishing your snapshot.',
    body:
      'StayReel works best for accounts under ~5,000 followers, so larger accounts may show partial results.',
  },

  /** FAQ-style bullets shown in Settings > About section. */
  faq: {
    title: 'Account Size & Scanning',
    bullets: [
      'StayReel scans followers in batches.',
      'Accounts under ~5,000 followers typically get full results.',
      'Larger accounts may take longer and show partial data.',
    ],
  },
} as const;
