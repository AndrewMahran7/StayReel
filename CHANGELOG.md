# Changelog

## v1.6.0 (2026-04-22)

### Architecture
- **Server-owned snapshot lifecycle**: The backend now fully owns job execution, continuation, progress, and notifications. The client no longer polls.
  - New edge function `snapshot-worker` claims a per-job lock, runs one chunk, persists progress, claims milestone notifications atomically, and self-triggers until terminal.
  - `snapshot-start` is now fire-and-forget: it creates the job, fires the STARTED push, triggers the worker, and returns immediately.
  - `process-stale-jobs` is the fallback scheduler — it sweeps `next_run_at <= now` jobs and re-dispatches stale heartbeats to the worker.
  - `snapshot-continue` returns HTTP 410 (removed); old client builds fail fast instead of contending with the worker for the lock.

### Frontend
- **`useSnapshotCapture` rewrite**: All polling-era fields removed (`pagesDone`, `followersSeen`, `followingSeen`, `etaLabel`, `isFirstSnapshot`, `partialResultsReady`, `followerCountApi`). New shape: `{ stage, percent, queued, queueMessage, resumed, followingCached }`. Added `setExternalProgress` / `resetProgress` / `setIsPending` for reconciliation sync.
- **Reconciliation sync**: `useSnapshotReconciliation` now returns `progressPercent` + `progressStage` for `still_running`/`still_queued` actions. The dashboard syncs them to local state instead of re-firing `snapshot-start` to "auto-resume" a polling loop.
- **Dashboard progress card**: Stage derivation rewritten to use server-owned `progress_percent` + `progress_stage`. Dead UI removed (live partial-NFB counter). Step indicator and progress bar now reflect server truth.
- **Foreground notification refresh**: `useNotifications` adds an `addNotificationReceivedListener` so dashboard data is invalidated as soon as a milestone push lands while the app is open. No polling required.

### New lists
- **Followers / Following / Friends** lists exposed via tappable stats. Friends = `setIntersection(following, followers)` from the latest snapshot's denormalised JSON. New `TABS` and `UPSELL_COPY` entries in the lists screen; empty-state copy distinguishes primary lists from diff-only lists.

### Database
- Migration `030_server_owned_snapshot_lifecycle.sql`: 15 new columns on `snapshot_jobs` (`next_run_at`, `progress_percent`, `progress_stage`, `progress_mode`, `completed_work_units`, `total_work_units`, `followers_target_count`, `following_target_count`, `following_cached`, `notification_mask`, `last_notified_percent`, `last_chunk_started_at`, `last_chunk_completed_at`, `worker_attempt_count`, `consecutive_retry_count`), constraints, and a runnable index.

### Notifications
- **Atomic milestone delivery**: `snapshot_jobs.notification_mask` is a bitmask CAS — STARTED / 25 / 50 / 75 / ALMOST / COMPLETE / FAILED / RECONNECT. Workers and the fallback scheduler can never double-send.
- **Reconnect / failed milestones** route to the correct screen and respect `user_settings.notify_refresh_complete` / `notify_on_token_expiry`.

## v1.5.4 (2025-04-19)

### Features
- **Auto-snapshot opt-in**: Default changed from ON → OFF. Users must explicitly enable automatic snapshots via Settings. Migration 029 resets all existing accounts.
- **Partial results UX**: Dashboard shows an amber notice when a scan is incomplete (large accounts). Server returns `isListComplete` flag; client fires `snapshot_partial_complete` analytics event.
- **Account size messaging**: Onboarding hint, dashboard partial notice, and Settings FAQ section warn about ~5,000-follower practical limit.
- **Feature flags**: `ENABLE_POST_CONNECT_ONBOARDING` flag disables school/referral onboarding modals without removing code.

### Bug Fixes
- **Terms persistence race condition**: Terms acceptance check now runs in parallel (Promise.all) with IG account query at boot, eliminating the flash of the terms modal after acceptance.
- **Post-connect freeze**: Scoped `invalidateQueries` to `['dashboard']` only — prevents thundering-herd refetch that caused a render freeze on the connect-instagram screen.
- **Smart-notify auto-snapshot gate**: smart-notify now checks `auto_snapshot_enabled` before sending notifications for auto-snapshots (defense-in-depth).

### Infrastructure
- **Pagination tuning**: `MAX_PAGES` increased from 120 → 420 (supports accounts up to ~8,400 followers per direction).
- **`isListComplete` on ChunkResult**: Server finalize phase sets and returns `isListComplete`; client propagates to `CaptureResult.is_list_complete`.
- **Analytics**: Added `snapshot_partial_complete`, `auto_snapshots_enabled_on`, `auto_snapshots_enabled_off` events to FunnelEvent type.
- **Auto-snapshot toggle UX**: Updated copy to warn about increased IG activity; tracks enable/disable via analytics.
- **Settings FAQ block**: Account Size & Scanning section added to Settings.

### Tests
- `__tests__/autoSnapshotOptIn.test.ts` — 13 tests covering opt-in default, scheduler eligibility, smart-notify gate
- `__tests__/postConnectOnboarding.test.ts` — 14 tests covering feature flag gating of school/referral flows
- `__tests__/snapshotPartialComplete.test.ts` — 20 tests covering isListComplete propagation, PAGE_LIMIT_REACHED classification, analytics, partial notice visibility
