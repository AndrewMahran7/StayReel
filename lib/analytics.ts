// lib/analytics.ts
// Lightweight funnel analytics — fire-and-forget INSERT into
// public.funnel_events via the authenticated Supabase client.
//
// ── Event catalogue ──────────────────────────────────────────
//   snapshot_started        – user tapped "Take Snapshot"
//   snapshot_completed      – snapshot finished successfully
//   snapshot_failed         – snapshot errored out
//   list_opened             – user switched to a list tab
//   locked_rows_seen        – free user scrolled to locked rows
//   upgrade_cta_clicked     – user tapped an "Unlock" button
//   paywall_opened          – paywall modal became visible
//   purchase_completed      – RevenueCat confirmed a purchase
//   review_prompt_shown     – App Store review dialog was fired
//   referral_applied        – ambassador referral code attributed
// ─────────────────────────────────────────────────────────────

import { supabase } from '@/lib/supabase';

export type FunnelEvent =
  | 'snapshot_started'
  | 'snapshot_completed'
  | 'snapshot_failed'
  | 'list_opened'
  | 'locked_rows_seen'
  | 'upgrade_cta_clicked'
  | 'paywall_opened'
  | 'purchase_completed'
  | 'review_prompt_shown'
  | 'referral_applied'
  | 'beta_access_shown'
  | 'instagram_connected'
  | 'paywall_suppressed'
  | 'invite_tapped'
  | 'auto_snapshot_scheduled'
  | 'auto_snapshot_started'
  | 'auto_snapshot_completed'
  | 'auto_snapshot_skipped'
  | 'meaningful_change_detected'
  | 'notification_sent'
  | 'reconnect_required_entered'
  | 'reconnect_notification_sent'
  | 'reconnect_completed';

/**
 * Fire-and-forget: logs a funnel event for the current authenticated user.
 * Silently no-ops if the user is not signed in or if the INSERT fails —
 * analytics should never block the UI or throw.
 */
export function trackEvent(
  event: FunnelEvent,
  payload?: Record<string, unknown>,
): void {
  (async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { error } = await supabase.from('funnel_events').insert({
        user_id:    user.id,
        event_name: event,
        payload:    payload ?? null,
      });

      if (error) {
        console.warn('[Analytics] INSERT failed:', error.message);
      }
    } catch {
      // Non-critical — silently ignore
    }
  })();
}
