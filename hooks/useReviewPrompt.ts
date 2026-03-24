// hooks/useReviewPrompt.ts
// Triggers an App Store review prompt after the user has received
// clear value — specifically, after opening a high-value list
// (e.g. "Not following back" or "Lost followers") and seeing real results.
//
// Uses expo-store-review which calls SKStoreReviewController under
// the hood. Apple rate-limits the native dialog to ~3 times per
// 365-day period, so even if our gates pass, Apple may silently no-op.
//
// ── Decision rules (plain English) ─────────────────────────────────
//
//   Show the review prompt ONLY when ALL of these are true:
//
//   1. The user has completed at least 2 successful snapshots.
//   2. The user is currently viewing a high-value list
//      (Ghost, Lost, or Secret Fans) with at least 1 real result.
//   3. At least 60 days have passed since the last prompt.
//   4. The prompt has been shown fewer than 2 times total (lifetime).
//   5. The native StoreReview API is available on this device.
//   6. We have not already prompted during this app session.
//
//   After the prompt is shown, we record the timestamp and increment
//   the prompt counter. If the user dismisses (Apple doesn't tell us
//   whether they reviewed or dismissed, but we track the attempt),
//   the 60-day cooldown and lifetime cap prevent further spam.
//
// ───────────────────────────────────────────────────────────────────

import { useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as StoreReview from 'expo-store-review';
import type { ListType } from '@/hooks/useListData';
import { trackEvent } from '@/lib/analytics';

// ── AsyncStorage keys ──────────────────────────────────────────────
const SNAPSHOT_COUNT_KEY = '@stayreel:successful_snapshots';
const PROMPT_COUNT_KEY   = '@stayreel:review_prompt_count';
const LAST_PROMPT_KEY    = '@stayreel:review_last_prompted_at';

// ── Tuning constants ───────────────────────────────────────────────
/** Minimum successful snapshots before any prompt is possible. */
const MIN_SNAPSHOTS = 2;

/** Minimum days between prompts. */
const COOLDOWN_DAYS = 60;

/** Maximum number of times we ever trigger the prompt per install. */
const MAX_PROMPTS = 2;

/** Delay (ms) after list load before showing the prompt. */
const DISPLAY_DELAY_MS = 3_000;

/** List types that represent a genuine "value moment". */
const HIGH_VALUE_LISTS: ListType[] = [
  'not_following_back',
  'lost_followers',
  'you_dont_follow_back',
];

// ── Helpers ────────────────────────────────────────────────────────

async function getInt(key: string): Promise<number> {
  const raw = await AsyncStorage.getItem(key);
  return parseInt(raw ?? '0', 10) || 0;
}

/**
 * Increment the successful-snapshot counter.
 * Call from dashboard.tsx after every successful capture.
 * Separated from the prompt trigger so the dashboard doesn't need
 * to know about review-prompt timing.
 */
export async function recordSuccessfulSnapshot(): Promise<void> {
  try {
    const count = (await getInt(SNAPSHOT_COUNT_KEY)) + 1;
    await AsyncStorage.setItem(SNAPSHOT_COUNT_KEY, String(count));
    console.log('[ReviewPrompt] Snapshot count:', count);
  } catch {
    // Non-critical
  }
}

/**
 * Hook that exposes `maybePromptReview(listType, itemCount)`.
 *
 * Call from the lists screen when a high-value list loads with results.
 * Checks all anti-spam gates before calling StoreReview.
 */
export function useReviewPrompt() {
  // Session-level guard: never prompt twice in one app launch.
  const prompted = useRef(false);

  const maybePromptReview = useCallback(async (
    listType: ListType,
    itemCount: number,
  ) => {
    if (prompted.current) return;

    try {
      // ── Gate 1: high-value list ─────────────────────────────
      if (!HIGH_VALUE_LISTS.includes(listType)) return;

      // ── Gate 2: real results visible ────────────────────────
      if (itemCount < 1) return;

      // ── Gate 3: enough snapshots completed ──────────────────
      const snapCount = await getInt(SNAPSHOT_COUNT_KEY);
      if (snapCount < MIN_SNAPSHOTS) return;

      // ── Gate 4: lifetime cap ────────────────────────────────
      const promptCount = await getInt(PROMPT_COUNT_KEY);
      if (promptCount >= MAX_PROMPTS) return;

      // ── Gate 5: 60-day cooldown ─────────────────────────────
      const lastTs = await getInt(LAST_PROMPT_KEY);
      if (lastTs > 0) {
        const daysSince = (Date.now() - lastTs) / (1_000 * 60 * 60 * 24);
        if (daysSince < COOLDOWN_DAYS) return;
      }

      // ── Gate 6: native API available ────────────────────────
      const available = await StoreReview.isAvailableAsync();
      if (!available) {
        console.log('[ReviewPrompt] StoreReview not available on this device');
        return;
      }

      // Delay so the user reads the list content first
      await new Promise((r) => setTimeout(r, DISPLAY_DELAY_MS));

      // Fire the native review dialog
      await StoreReview.requestReview();

      // Record the attempt (Apple doesn't tell us review vs dismiss,
      // so we treat every invocation as "prompted").
      await AsyncStorage.setItem(PROMPT_COUNT_KEY, String(promptCount + 1));
      await AsyncStorage.setItem(LAST_PROMPT_KEY, String(Date.now()));
      prompted.current = true;

      trackEvent('review_prompt_shown', {
        list_type:    listType,
        item_count:   itemCount,
        prompt_number: promptCount + 1,
      });

      console.log(
        '[ReviewPrompt] Prompted (#%d) on list: %s — next eligible in %d days',
        promptCount + 1,
        listType,
        COOLDOWN_DAYS,
      );
    } catch (err) {
      // Non-critical — silently ignore
      console.warn('[ReviewPrompt] Error:', err);
    }
  }, []);

  return { maybePromptReview };
}

