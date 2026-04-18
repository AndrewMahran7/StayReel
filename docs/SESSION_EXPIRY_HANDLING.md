# Session Expiry Handling

How the snapshot pipeline detects, classifies, and recovers from Instagram session failures — **without ever surfacing raw errors to the user**.

> **Design principle:** Reconnect-required is a first-class product state, not an error path. The server returns structured product-state responses (not thrown errors). The client renders calm "tracking paused" UX. Technical details stay in server logs only. All user-facing copy is centralized in `lib/reconnectCopy.ts`.

---

## Tracking State Model

The app exposes a product-facing `TrackingState` instead of raw error codes:

| State | When | User sees |
|---|---|---|
| `tracking_active` | Account is connected and working | Normal dashboard |
| `tracking_updating` | Snapshot is in progress | Progress indicator |
| `tracking_paused_reconnect_required` | Session expired or challenge needed | Calm reconnect banner |
| `tracking_paused_temporary_issue` | Rate limit or network error | Retry later messaging |

`diffs-latest` returns `tracking_state` alongside the existing `reconnect_required` boolean.

## Failure Classification

Every Instagram API failure (`FailureCode`) is mapped to one of five semantic categories by `classifyFetchFailure()` in `_shared/instagram.ts`:

| Category | FailureCodes | Meaning |
|---|---|---|
| `session_expired` | `SESSION_EXPIRED`, `IG_SESSION_INVALID` | The stored session cookies are no longer valid. |
| `checkpoint_or_challenge` | `CHALLENGE_REQUIRED`, `CHECKPOINT_REQUIRED`, `IG_CHALLENGE_REQUIRED` | Instagram is requesting identity verification. |
| `rate_limited` | `IG_RATE_LIMITED` | Too many requests; temporary back-off needed. |
| `temporary_network_failure` | `NETWORK_ERROR` | Transient connectivity issue. |
| `unknown_fetch_error` | Everything else (`SUSPICIOUS_RESPONSE`, `PAGE_LIMIT_REACHED`, etc.) | Unclassified — may or may not be recoverable. |

`requiresReconnect(category)` returns `true` only for `session_expired` and `checkpoint_or_challenge`. These are the two categories that cannot be resolved without the user re-authenticating.

## Continuation Precheck

Before each chunk of work in `snapshotJob.ts`, a lightweight auth precheck runs:

```
precheckSession(sessionId, deviceProfile)
  → GET /api/v1/accounts/current_user/?edit=true
  → Returns FailureCode | null
```

**Flow:**

1. `snapshot-continue` polls → `runSnapshotChunk()` is called.
2. Before any phase work (followers/following), `precheckSession()` fires.
3. If it returns a `FailureCode`:
   - Partial progress (edges + pages) is persisted to the job row.
   - If `requiresReconnect(category)` → `markAccountReconnectRequired()` flags the account.
   - The job is failed with the classified code.
4. If it returns `null` → proceed with normal phase work.

The precheck is skipped during the `finalize` phase since no IG API calls are made there.

## Partial Progress Preservation

When a failure occurs mid-pagination (either from the precheck or from `fetchEdgeListChunked`), the pipeline saves whatever edges have been collected so far:

- **Followers phase:** `followers_json` and `pages_done` are persisted before `failJob()`.
- **Following phase:** `following_json` and `pages_done` are persisted before `failJob()`.

This means that when the user reconnects and restarts, the job resumes from where it left off rather than starting from scratch.

## Account Reconnect State

### Setting the flag

`markAccountReconnectRequired()` in `snapshotJob.ts` updates `ig_accounts`:

```sql
reconnect_required = true
last_auth_error_code = <FailureCode>
last_auth_error_message = <description>
last_auth_error_at = now()
status = 'token_expired'
```

### How it blocks

Once `reconnect_required = true`, the account is blocked at every entry point:

| Entry point | Behavior |
|---|---|
| `snapshot-start` | Returns HTTP 200 JSON: `{ reconnect_required: true, tracking_state: "tracking_paused_reconnect_required", done: true }`. **Not a thrown error.** |
| `snapshot-continue` | Returns HTTP 200 JSON: `{ reconnect_required: true, tracking_state: "tracking_paused_reconnect_required", done: true }`. Job marked failed with `RECONNECT_REQUIRED` code. |
| `auto-snapshot-scheduler` | Filters out the account from eligible list. |
| `process-stale-jobs` | Treats the account as unavailable; fails the stale job. |

### Reconnect Notification

When `markAccountReconnectRequired()` fires, it sends a **one-time push notification** (if the user has opted in):

- Checks `user_settings.notify_on_token_expiry` preference
- Checks `profiles.push_token` exists
- Sends: title "Reconnect Instagram", body "StayReel is paused until you reconnect Instagram. Tap to reconnect."
- Data payload: `{ screen: "settings", source: "reconnect_required" }`

The notification fires once per transition (not on every blocked request).

### Analytics Events

Three lifecycle events are tracked in `funnel_events`:

| Event | When | Payload |
|---|---|---|
| `reconnect_required_entered` | Account transitions into reconnect_required | `{ ig_account_id, error_code }` |
| `reconnect_notification_sent` | Push notification dispatched for reconnect | `{ ig_account_id }` |
| `reconnect_completed` | User successfully reconnects via connect-instagram | (client-side event) |

Allows tracking: time-to-reconnect, notification effectiveness, reconnect funnel drop-off.

### Clearing the flag

When the user successfully reconnects via `connect-instagram`, the upsert resets:

```sql
reconnect_required = false
last_auth_error_code = null
last_auth_error_message = null
last_auth_error_at = null
auto_snapshot_fail_count = 0
status = 'active'
```

After this, all entry points allow jobs again.

## Account State Lifecycle

```
ACTIVE
  │
  ├─ session expires during job
  │       │
  │       ▼
  │  RECONNECT REQUIRED
  │   • reconnect_required = true
  │   • status = token_expired
  │   • all jobs blocked
  │   • dashboard shows reconnect banner
  │       │
  │       ├─ user reconnects (connect-instagram)
  │       │       │
  │       │       ▼
  │       │  ACTIVE (flags cleared)
  │       │
  │       └─ user does nothing
  │               → stays blocked indefinitely
  │
  ├─ rate limited
  │       → cooldown extended, retry later (no reconnect)
  │
  └─ network error
          → job fails, retry later (no reconnect)
```

## Dashboard UX

### What the user sees

When `reconnect_required` is true, the dashboard transitions to a calm "paused" state:

- **Reconnect banner** (amber): Icon `refresh-circle-outline`, title from `RECONNECT_COPY.bannerTitle`, body from `RECONNECT_COPY.bannerBody`, button from `RECONNECT_COPY.bannerButton`. Shown when `needsReconnect` is true (driven by `tracking_state` from server)
- **Snapshot button**: Shows `RECONNECT_COPY.snapshotButtonLabel` ("Paused", disabled) with `refresh-outline` icon
- **Info text**: `RECONNECT_COPY.infoText` ("Reconnect your Instagram to resume tracking.")
- **Snapshot status card**: Header changes to "Tracking Paused", next auto shows "Paused until reconnect", auto snapshots shows "Paused"
- **All existing data remains visible**: follower/following counts, streak, weekly summary, list cards — everything is preserved and tappable
- **No error card**: `SnapshotErrorCard` has **no reconnect profiles** — reconnect codes (SESSION_EXPIRED, IG_SESSION_INVALID, CHALLENGE_REQUIRED, CHECKPOINT_REQUIRED, IG_CHALLENGE_REQUIRED) are not registered in the component at all. The reconnect banner is the sole UX for this state.

### What the user does NOT see

- No "error" or "failure" language
- No "expired" wording
- No `SnapshotErrorCard` for session/challenge codes
- No red/destructive UI elements
- No technical error codes or stack traces

### Data flow

The `diffs-latest` endpoint returns `reconnect_required`, `last_auth_error_code`, and `tracking_state` to the client.

The dashboard computes `needsReconnect` from three sources (priority order):
1. **Primary — server tracking state:** `data.tracking_state === 'tracking_paused_reconnect_required'`
2. **Secondary — explicit flag:** `data.reconnect_required === true`
3. **TEMPORARY FALLBACK — error code inference:** snapshot error code is in `RECONNECT_CODES` set. This fires only when the server state hasn't propagated yet (e.g. error occurred this session but diffs-latest hasn't refetched). Logs a `console.warn` when triggered. Will be removed once all clients use structured reconnect responses.

### Client-side error suppression

**Primary path (structured response):** `snapshot-start` returns HTTP 200 with `{ reconnect_required: true, tracking_state, done: true }`. The client hook detects `body.reconnect_required === true` before checking `res.ok` and returns a silent done response — no error is ever set.

**Fallback path (legacy compatibility):** If any server error response contains a `RECONNECT_FAILURE_CODES` code, the hook returns silently instead of throwing.

**Poll loop:** `snapshot-continue` responses with `reconnect_required: true` are handled identically — silent return, no error set.

The reconciliation hook returns `{ type: 'reconnect_required' }` instead of `{ type: 'failed' }` for reconnect codes. The dashboard handler clears any lingering error and refetches data.

A `useEffect` auto-clears `capture.error` if the error code belongs to the `RECONNECT_CODES` set (defense-in-depth).

### Why SnapshotErrorCard has no reconnect profiles

Reconnect-required codes are **not registered** in `SnapshotErrorCard`'s `PROFILES` map. This is intentional:

1. The server returns structured reconnect responses (HTTP 200), so no `SnapshotError` is created for reconnect cases.
2. The client hook detects `body.reconnect_required` before error handling and returns silently.
3. Even if a reconnect error reached the component, it would get the generic `UNKNOWN_PROFILE` fallback — but this is irrelevant because the dashboard auto-clears reconnect errors via `useEffect` before the error card renders.
4. The reconnect banner is the **sole** user-facing surface for this state.

Result: there are zero code paths where a reconnect code can render through SnapshotErrorCard.

## Schema (Migration 027)

Fields added to `ig_accounts`:

| Column | Type | Default |
|---|---|---|
| `reconnect_required` | `boolean` | `false` |
| `last_auth_error_code` | `text` | `null` |
| `last_auth_error_message` | `text` | `null` |
| `last_auth_error_at` | `timestamptz` | `null` |

A partial index `idx_ig_accounts_reconnect` is created on `reconnect_required WHERE reconnect_required = true` for efficient filtering.

## Resume Behavior

### Same-job resume (app backgrounding, poll interruption)

When a snapshot job is interrupted (app backgrounded, network lost, poll timeout), the job's state is fully persisted:

| Field | What's saved |
|---|---|
| `followers_json` | All follower edges fetched so far |
| `following_json` | All following edges fetched so far |
| `followers_cursor` | Instagram pagination cursor (encoded as `cursor\|rankToken`) |
| `following_cursor` | Instagram pagination cursor |
| `pages_done` | Total pages fetched across all invocations |
| `phase` | Current phase (`followers`, `following`, `finalize`) |

When `snapshot-start` is called for an account with a running/queued job, it returns the existing job for resumption. `snapshot-continue` loads the job row with all saved state, and `runSnapshotChunk` resumes from the saved cursor, continuing pagination exactly where it left off. Deduplication via `deduplicateEdges()` prevents duplicate entries if edges overlap.

### Resume control flow (exact sequence)

1. `snapshot-continue` is called for a job
2. Job row is loaded from DB with all checkpoint fields
3. Checkpoint fields are destructured into local mutable variables:
   ```
   let followers  = [...job.followers_json]
   let following  = [...job.following_json]
   let pagesDone  = job.pages_done
   let followersCursor = job.followers_cursor   // encoded as "cursor|rankToken"
   let followingCursor = job.following_cursor
   ```
4. `parseCursorField(followersCursor)` extracts `{ cursor, rankToken }`
5. Both are passed to `fetchEdgeListChunked(igUserId, "followers", cookie, { startCursor, rankToken, ... })`
6. Returned edges are merged with existing: `followers = deduplicateEdges([...followers, ...result.edges])`
7. New cursor is encoded and persisted: `encodeCursorField(result.nextCursor, rankToken)`
8. Same pattern for following phase
9. In finalize phase, the full accumulated `followers` and `following` arrays are used for snapshot insert and diff computation

Key guarantees:
- Cursors (with rank tokens) are faithfully round-tripped through the DB
- Edges are merged and deduplicated on every invocation via `deduplicateEdges()`
- Finalize operates on the complete accumulated data
- No path exists where a resume can produce duplicate edges or skip the cursor

### Post-reconnect resume

After a reconnect, the user starts a **new job from scratch**. The old failed job's progress is not reused because:

1. The Instagram API cursor from the expired session is invalid with the new session cookie
2. The rank_token (used for pagination consistency) is session-specific
3. Mixing partial edge data from two different sessions could produce incorrect diffs

However, the `following_json` **IS cached** from the most recent complete snapshot (24h window). If a complete snapshot exists from earlier today, the following phase is skipped entirely — only followers need to be re-fetched.

## Non-Auth Failures

Failures classified as `rate_limited`, `temporary_network_failure`, or `unknown_fetch_error` do **not** set `reconnect_required`. They fail the job normally, surface `SnapshotErrorCard` (which only contains non-reconnect profiles like `IG_RATE_LIMITED`, `NETWORK_ERROR`, `SNAPSHOT_LIMIT`), and the user (or auto-scheduler) can retry later without reconnecting.

Temporary failures do NOT:
- Set `reconnect_required`
- Show reconnect banner/messaging
- Disable the account indefinitely
- Block auto-snapshot scheduling (beyond normal backoff)

## User-Facing Copy Reference

All reconnect-related user-facing copy is centralized in `lib/reconnectCopy.ts`. Import from there instead of hardcoding strings.

| Surface | Key | Copy |
|---|---|---|
| Reconnect banner title | `bannerTitle` | "Reconnect Instagram to keep tracking active" |
| Reconnect banner body | `bannerBody` | "Tracking is paused until you reconnect. Your history and results are safe." |
| Reconnect banner button | `bannerButton` | "Reconnect Instagram" |
| Snapshot button (disabled) | `snapshotButtonLabel` | "Paused" |
| Info text below button | `infoText` | "Reconnect your Instagram to resume tracking." |
| Manual snapshot disabled | `manualDisabledHelper` | "Reconnect Instagram to take new snapshots." |
| Status card next auto | `statusCardNextAuto` | "Paused until reconnect" |
| Status card auto label | `statusCardAutoLabel` | "Paused" |
| Push notification title | `pushTitle` | "Reconnect Instagram" |
| Push notification body | `pushBody` | "StayReel is paused until you reconnect Instagram. Tap to reconnect." |
| snapshot-start response | `serverStartBlocked` | "Reconnect Instagram to keep tracking active." |
| snapshot-continue response | `serverContinueBlocked` | "Tracking is paused until you reconnect Instagram." |

### Copy NOT shown to users

| Surface | Copy | Visibility |
|---|---|---|
| snapshotJob internal log | "[auth] Partial progress preserved..." | Server logs only |

Reconnect-related profiles (SESSION_EXPIRED, CHALLENGE_REQUIRED, etc.) have been **removed** from `SnapshotErrorCard` entirely. There is no dead copy to suppress — the profiles simply don't exist in the component.
