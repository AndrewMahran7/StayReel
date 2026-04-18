// lib/reconnectCopy.ts
// Centralized user-facing copy for the reconnect-required product state.
// No technical codes, error jargon, or failure language.
// Import from here instead of hardcoding reconnect strings.

export const RECONNECT_COPY = {
  // Dashboard reconnect banner
  bannerTitle: 'Reconnect Instagram to keep tracking active',
  bannerBody: 'Tracking is paused until you reconnect. Your history and results are safe.',
  bannerButton: 'Reconnect Instagram',

  // Snapshot button (disabled state)
  snapshotButtonLabel: 'Paused',

  // Info text below snapshot button
  infoText: 'Reconnect your Instagram to resume tracking.',

  // Manual snapshot disabled helper
  manualDisabledHelper: 'Reconnect Instagram to take new snapshots.',

  // Snapshot status card
  statusCardNextAuto: 'Paused until reconnect',
  statusCardAutoLabel: 'Paused',

  // Push notification (one-time on transition)
  pushTitle: 'Reconnect Instagram',
  pushBody: 'StayReel is paused until you reconnect Instagram. Tap to reconnect.',

  // Server responses (not user-facing, but calm language for logging)
  serverStartBlocked: 'Reconnect Instagram to keep tracking active.',
  serverContinueBlocked: 'Tracking is paused until you reconnect Instagram.',
  serverJobFailMessage: 'Reconnect Instagram to keep tracking active',
} as const;
