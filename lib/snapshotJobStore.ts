// lib/snapshotJobStore.ts
// Persists minimal snapshot job metadata to AsyncStorage so the app can
// detect and reconcile jobs that were in progress when the app was
// backgrounded, killed, or relaunched.
//
// This is advisory data only — the backend is always the source of truth.

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = '@stayreel/active_snapshot_job';

export interface PersistedJob {
  jobId:           string;
  igAccountId:     string;
  lastKnownStatus: 'running' | 'queued';
  startedAt:       string; // ISO-8601
}

export async function setActiveJob(job: PersistedJob): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch (err) {
    console.warn('[snapshotJobStore] Failed to save active job:', err);
  }
}

export async function getActiveJob(): Promise<PersistedJob | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedJob;
  } catch (err) {
    console.warn('[snapshotJobStore] Failed to load active job:', err);
    return null;
  }
}

export async function clearActiveJob(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[snapshotJobStore] Failed to clear active job:', err);
  }
}
