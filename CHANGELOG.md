# Changelog

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
