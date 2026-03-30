// lib/offlineStorage.ts
// Simple persistence for the latest snapshot (DiffSummary) so users can
// view their data when offline.  Uses AsyncStorage which is already a
// project dependency — no extra installs needed.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DiffSummary } from '@/hooks/useDashboard';

const STORAGE_KEY = '@stayreel/last_snapshot';

export interface StoredSnapshot {
  /** The full dashboard diff summary. */
  data: DiffSummary;
  /** ISO-8601 timestamp of when it was saved. */
  savedAt: string;
}

/**
 * Persist the latest snapshot to local storage.
 * Overwrites any previously stored snapshot (no merging).
 */
export async function saveSnapshot(data: DiffSummary): Promise<void> {
  try {
    const payload: StoredSnapshot = {
      data,
      savedAt: new Date().toISOString(),
    };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Non-critical — log but never crash the app.
    console.warn('[offlineStorage] Failed to save snapshot:', err);
  }
}

/**
 * Load the most recently saved snapshot from local storage.
 * Returns `null` when nothing is stored or if parsing fails.
 */
export async function loadSnapshot(): Promise<StoredSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSnapshot;
  } catch (err) {
    console.warn('[offlineStorage] Failed to load snapshot:', err);
    return null;
  }
}

/**
 * Remove the stored snapshot (e.g. on sign-out).
 */
export async function clearSnapshot(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[offlineStorage] Failed to clear snapshot:', err);
  }
}
