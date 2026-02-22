// _shared/instagram.ts
//
// Fetches a user's own followers and following lists using a
// web session cookie string they obtain themselves.
//
// SECURITY CONTRACT
// ─────────────────
// • Passwords are NEVER accepted, read, or stored anywhere in this module.
// • This module only reads from Instagram — no write, like, follow, or
//   message actions are ever performed.
// • The session cookie is consumed in-memory only; it is stored encrypted
//   in Supabase Vault by the calling Edge Function — never in plaintext.
//
// SELF-IMPOSED LIMITS (conservative by design)
// ─────────────────────────────────────────────
// • MAX_PAGES = 20 per direction (≤ 4 000 edges per run at 200/page)
// • Inter-page delay: 600–1 200 ms randomised
// • Retry backoff: 2 s → 4 s → 8 s → 16 s (max 4 retries, jittered)
// • Immediate halt on any challenge, checkpoint, or suspicious redirect
// • Partial results returned when stopped early — never an exception

// (No AppError/Errors imports needed — this module uses its own result types)

// ─────────────────────────────────────────────────────────────
// Failure mode catalogue
// ─────────────────────────────────────────────────────────────

export type FailureCode =
  | "CHALLENGE_REQUIRED"    // Instagram demands email/SMS verification
  | "CHECKPOINT_REQUIRED"   // Account locked / unusual activity gate
  | "SESSION_EXPIRED"       // 401 or explicit login-required response
  | "IG_RATE_LIMITED"       // 429 from Instagram
  | "PRIVATE_ACCOUNT"       // Target account is private
  | "USER_NOT_FOUND"        // Username doesn't exist or was changed
  | "PAGE_LIMIT_REACHED"    // Hit our own MAX_PAGES cap; data is partial
  | "NETWORK_ERROR"         // Underlying fetch failed (DNS, timeout, etc.)
  | "SUSPICIOUS_RESPONSE";  // Unexpected shape that may indicate a block

export interface FailureModeInfo {
  /** Machine-readable code (matches FailureCode) */
  code: FailureCode;
  /** Short title for a toast or alert header */
  uiTitle: string;
  /** Human-readable explanation for the user */
  uiMessage: string;
  /** Whether the client should encourage an immediate retry */
  isRetryable: boolean;
  /** Approximate wait before next attempt makes sense */
  retryAfterHours: number;
  /** Whether the user must reconnect their Instagram account */
  requiresReauth: boolean;
}

/** Complete UI messaging for every failure code the module can emit. */
export const FAILURE_MODES: Readonly<Record<FailureCode, FailureModeInfo>> = {
  CHALLENGE_REQUIRED: {
    code: "CHALLENGE_REQUIRED",
    uiTitle: "Instagram Needs Verification",
    uiMessage:
      "Instagram has flagged unusual activity and requires you to verify your " +
      "identity (email or SMS code). Please open the Instagram app, complete " +
      "the verification, then reconnect your account here.",
    isRetryable: false,
    retryAfterHours: 24,
    requiresReauth: true,
  },
  CHECKPOINT_REQUIRED: {
    code: "CHECKPOINT_REQUIRED",
    uiTitle: "Account Checkpoint",
    uiMessage:
      "Instagram has temporarily restricted access to your account. Open the " +
      "Instagram app to resolve the checkpoint, then reconnect here.",
    isRetryable: false,
    retryAfterHours: 48,
    requiresReauth: true,
  },
  SESSION_EXPIRED: {
    code: "SESSION_EXPIRED",
    uiTitle: "Session Expired",
    uiMessage:
      "Your Instagram session has expired (this happens every 90 days or when " +
      "you log out). Please reconnect your account to continue tracking.",
    isRetryable: false,
    retryAfterHours: 0,
    requiresReauth: true,
  },
  IG_RATE_LIMITED: {
    code: "IG_RATE_LIMITED",
    uiTitle: "Too Many Requests",
    uiMessage:
      "Instagram has temporarily throttled requests from your session. " +
      "This usually clears in 1–6 hours. We've saved the data captured so far.",
    isRetryable: true,
    retryAfterHours: 6,
    requiresReauth: false,
  },
  PRIVATE_ACCOUNT: {
    code: "PRIVATE_ACCOUNT",
    uiTitle: "Private Account",
    uiMessage:
      "This feature only works with your own Instagram account. " +
      "Make sure you are connecting the account you own.",
    isRetryable: false,
    retryAfterHours: 0,
    requiresReauth: false,
  },
  USER_NOT_FOUND: {
    code: "USER_NOT_FOUND",
    uiTitle: "Account Not Found",
    uiMessage:
      "We couldn't find an Instagram account with that username. " +
      "It may have been deleted or renamed. Please reconnect with the correct account.",
    isRetryable: false,
    retryAfterHours: 0,
    requiresReauth: true,
  },
  PAGE_LIMIT_REACHED: {
    code: "PAGE_LIMIT_REACHED",
    uiTitle: "Large Account — Partial Data",
    uiMessage:
      "Your follower list is very large. We've captured the most recent portion " +
      "and will continue at the next scheduled refresh. Diffs may be incomplete " +
      "until the full list is captured.",
    isRetryable: true,
    retryAfterHours: 6,
    requiresReauth: false,
  },
  NETWORK_ERROR: {
    code: "NETWORK_ERROR",
    uiTitle: "Network Error",
    uiMessage:
      "A network error occurred while contacting Instagram. " +
      "Check your connection and try again in a few minutes.",
    isRetryable: true,
    retryAfterHours: 0,
    requiresReauth: false,
  },
  SUSPICIOUS_RESPONSE: {
    code: "SUSPICIOUS_RESPONSE",
    uiTitle: "Unexpected Instagram Response",
    uiMessage:
      "Instagram returned an unexpected response. This may be a temporary issue " +
      "or a sign that Instagram has changed its API. " +
      "We've saved whatever data was captured. If this keeps happening, " +
      "try reconnecting your account.",
    isRetryable: true,
    retryAfterHours: 6,
    requiresReauth: false,
  },
};

// ─────────────────────────────────────────────────────────────
// Return type
// ─────────────────────────────────────────────────────────────

export interface IgEdge {
  /** Numeric Instagram user ID — may be empty string when unavailable */
  ig_id: string;
  username: string;
}

export interface FetchMeta {
  ig_user_id: string;
  username: string;
  follower_count_api: number;
  following_count_api: number;
  post_count_api: number;
  follower_pages_fetched: number;
  following_pages_fetched: number;
  is_followers_complete: boolean;
  is_following_complete: boolean;
  stopped_early: boolean;
  stop_reason: FailureCode | null;
  fetched_at: string;
}

export interface FetchResult {
  followers: IgEdge[];
  following: IgEdge[];
  meta: FetchMeta;
}

// ─────────────────────────────────────────────────────────────
// Internal constants
// ─────────────────────────────────────────────────────────────

const IG_API = "https://i.instagram.com/api/v1";
const IG_APP_ID = "936619743392459";
const USER_AGENT =
  "Instagram 314.0.0.35.109 Android (26/8.0.0; 480dpi; 1080x1920; " +
  "OnePlus; ONEPLUS A5000; OnePlus5; qcom; en_US; 556543836)";

/** Hard page cap per direction per run. 20 pages × 200 items = 4 000 max. */
const MAX_PAGES = 20;
const PAGE_SIZE = 200;

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS  = 32_000;
const BACKOFF_JITTER  = 1_000;
const MAX_RETRIES     = 4;

/** Polite inter-page pause: 2 500–5 000 ms randomised (reduced burst rate). */
const PAGE_DELAY_MIN  = 2_500;
const PAGE_DELAY_MAX  = 5_000;

/** Gap between followers and following fetches (sequential, not parallel). */
const DIRECTION_GAP_MIN = 3_000;
const DIRECTION_GAP_MAX = 6_000;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractCsrf(cookie: string): string {
  return cookie.match(/csrftoken=([^;\s]+)/)?.[1] ?? "";
}

function buildHeaders(cookie: string): HeadersInit {
  return {
    "User-Agent":           USER_AGENT,
    "Cookie":               cookie,
    "X-CSRFToken":          extractCsrf(cookie),
    "X-IG-App-ID":          IG_APP_ID,
    "X-IG-Capabilities":    "3brTvwE=",
    "X-IG-Connection-Type": "WIFI",
    "Accept-Language":      "en-US",
    "Accept":               "application/json",
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(baseMs: number): number {
  return baseMs + Math.random() * BACKOFF_JITTER;
}

function randomBetween(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}

// ─────────────────────────────────────────────────────────────
// Challenge / checkpoint body detection
// ─────────────────────────────────────────────────────────────

/** Returns a FailureCode if the response body signals a block, else null. */
function classifyBlockBody(
  body: Record<string, unknown>,
  status: number,
): FailureCode | null {
  const msg   = String(body?.message ?? "").toLowerCase();
  const fbMsg = String(body?.feedback_message ?? "").toLowerCase();
  const error = String(body?.error_type ?? "").toLowerCase();

  if (body?.challenge || body?.challenge_required) return "CHALLENGE_REQUIRED";
  if (msg.includes("checkpoint") || error.includes("checkpoint") || fbMsg.includes("checkpoint")) return "CHECKPOINT_REQUIRED";
  if (msg.includes("challenge") || error.includes("challenge_required")) return "CHALLENGE_REQUIRED";
  if (status === 401 || msg.includes("login") || msg.includes("not authenticated") || error.includes("login_required")) return "SESSION_EXPIRED";
  if (msg.includes("private") || error.includes("private_user")) return "PRIVATE_ACCOUNT";
  if (status === 404 || msg.includes("user not found") || msg.includes("sorry")) return "USER_NOT_FOUND";
  return null;
}

// ─────────────────────────────────────────────────────────────
// Core HTTP wrapper
// ─────────────────────────────────────────────────────────────

interface IgResponse { ok: true; body: Record<string, unknown>; }
interface IgFailure  { ok: false; failureCode: FailureCode; }
type IgResult = IgResponse | IgFailure;

async function igGet(url: string, cookie: string): Promise<IgResult> {
  let res: Response;
  try {
    res = await fetch(url, { method: "GET", headers: buildHeaders(cookie) });
  } catch {
    return { ok: false, failureCode: "NETWORK_ERROR" };
  }

  // Redirect to a challenge / checkpoint page (web flows)
  const finalUrl = res.url;
  if (finalUrl.includes("/challenge/") || finalUrl.includes("/checkpoint/")) {
    return { ok: false, failureCode: finalUrl.includes("checkpoint") ? "CHECKPOINT_REQUIRED" : "CHALLENGE_REQUIRED" };
  }

  if (res.status === 429) return { ok: false, failureCode: "IG_RATE_LIMITED" };

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await res.text().catch(() => "");
    if (text.includes("checkpoint") || text.includes("challenge") || text.includes("AccountRecovery")) {
      return { ok: false, failureCode: "CHALLENGE_REQUIRED" };
    }
    if (text.includes("login") || res.status === 401) return { ok: false, failureCode: "SESSION_EXPIRED" };
    return { ok: false, failureCode: "SUSPICIOUS_RESPONSE" };
  }

  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; }
  catch { return { ok: false, failureCode: "SUSPICIOUS_RESPONSE" }; }

  const bodyCode = classifyBlockBody(body, res.status);
  if (bodyCode) return { ok: false, failureCode: bodyCode };

  if (!res.ok) return { ok: false, failureCode: res.status >= 500 ? "NETWORK_ERROR" : "SUSPICIOUS_RESPONSE" };

  return { ok: true, body };
}

const NON_RETRYABLE: FailureCode[] = [
  "CHALLENGE_REQUIRED", "CHECKPOINT_REQUIRED",
  "SESSION_EXPIRED", "PRIVATE_ACCOUNT", "USER_NOT_FOUND",
];

async function igGetWithRetry(url: string, cookie: string): Promise<IgResult> {
  let attempt = 0;
  while (true) {
    const result = await igGet(url, cookie);
    if (result.ok) return result;
    if (NON_RETRYABLE.includes(result.failureCode)) return result;
    if (attempt >= MAX_RETRIES) return result;

    const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt + jitter(0), BACKOFF_MAX_MS);
    console.warn(`[ig] attempt ${attempt + 1}/${MAX_RETRIES} → ${result.failureCode}. Retrying in ${Math.round(delay)}ms`);
    await sleep(delay);
    attempt++;
  }
}

// ─────────────────────────────────────────────────────────────
// Session verification + profile
// ─────────────────────────────────────────────────────────────

export interface ProfileInfo {
  ig_id: string; username: string; full_name: string;
  profile_pic_url: string; is_business: boolean;
  follower_count: number; following_count: number;
  post_count: number; is_private: boolean;
}

async function getCurrentUserProfile(
  cookie: string,
): Promise<{ ok: true; profile: ProfileInfo } | { ok: false; failureCode: FailureCode }> {
  const result = await igGetWithRetry(`${IG_API}/accounts/current_user/?edit=true`, cookie);
  if (!result.ok) return result;

  const u  = (result.body.user ?? result.body) as Record<string, unknown>;
  const pk = String(u?.pk ?? u?.id ?? "");
  if (!pk) return { ok: false, failureCode: "SESSION_EXPIRED" };

  return {
    ok: true,
    profile: {
      ig_id:           pk,
      username:        String(u.username ?? ""),
      full_name:       String(u.full_name ?? ""),
      profile_pic_url: String(u.profile_pic_url ?? ""),
      is_business:     Boolean(u.is_business),
      follower_count:  Number(u.follower_count ?? 0),
      following_count: Number(u.following_count ?? 0),
      post_count:      Number(u.media_count ?? 0),
      is_private:      Boolean(u.is_private),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Paginated edge fetcher (followers OR following)
// ─────────────────────────────────────────────────────────────

interface EdgeListResult {
  edges: IgEdge[];
  pagesFetched: number;
  isComplete: boolean;
  stopReason: FailureCode | null;
}

// Generate a rank_token in the format Instagram's app uses: {igUserId}_{randomHex}
// This format is required for stable pagination on big_list accounts.
// Passing the wrong format causes Instagram to truncate results after 1–2 pages.
function newRankToken(igUserId: string): string {
  const hex = Array.from(
    (crypto as unknown as { getRandomValues: (a: Uint8Array) => Uint8Array })
      .getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return `${igUserId}_${hex}`;
}

async function fetchEdgeList(
  igUserId: string,
  direction: "followers" | "following",
  cookie: string,
): Promise<EdgeListResult> {
  const edges: IgEdge[] = [];
  let nextMaxId: string | null = null;
  let page = 0;
  // rank_token must include the user ID — required for big_list account pagination
  const rankToken = newRankToken(igUserId);

  while (page < MAX_PAGES) {
    const qs = new URLSearchParams({ count: String(PAGE_SIZE) });
    qs.set("rank_token", rankToken);
    if (nextMaxId) qs.set("max_id", nextMaxId);

    const url = `${IG_API}/friendships/${igUserId}/${direction}/?${qs.toString()}`;
    const result = await igGetWithRetry(url, cookie);

    if (!result.ok) {
      console.warn(`[ig] ${direction} page ${page + 1} stopped: ${result.failureCode}`);
      return { edges, pagesFetched: page, isComplete: false, stopReason: result.failureCode };
    }

    const users = (result.body.users ?? result.body.items ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(users)) {
      return { edges, pagesFetched: page, isComplete: false, stopReason: "SUSPICIOUS_RESPONSE" };
    }

    for (const u of users) {
      edges.push({ ig_id: String(u.pk ?? u.id ?? ""), username: String(u.username ?? "") });
    }

    page++;
    console.log(`[ig] ${direction} page ${page}: got ${users.length} users (total ${edges.length}), big_list=${result.body.big_list ?? false}`);

    // Resolve next cursor — check next_max_id first, then page_info.end_cursor
    // (big_list accounts sometimes use the latter).
    const rawCursor = result.body.next_max_id
      ?? (result.body.page_info as Record<string, unknown> | undefined)?.end_cursor
      ?? null;

    if (rawCursor !== null && rawCursor !== undefined && String(rawCursor).length > 0 && rawCursor !== "0" && rawCursor !== 0) {
      nextMaxId = String(rawCursor);
    } else {
      nextMaxId = null;
    }

    if (!nextMaxId) {
      const bigList = Boolean(result.body.big_list);
      if (bigList) {
        console.warn(`[ig] ${direction} page ${page}: big_list=true but no cursor — stopping at ${edges.length} edges`);
      } else {
        console.log(`[ig] ${direction} page ${page}: no cursor, list complete at ${edges.length} edges`);
      }
      return { edges, pagesFetched: page, isComplete: !bigList, stopReason: bigList ? "PAGE_LIMIT_REACHED" : null };
    }

    // Polite inter-page pause
    await sleep(randomBetween(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
  }

  // Hit the hard page cap
  console.warn(`[ig] ${direction}: hit MAX_PAGES (${MAX_PAGES}), stopped at ${edges.length} edges`);
  return { edges, pagesFetched: page, isComplete: false, stopReason: "PAGE_LIMIT_REACHED" };
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

/**
 * Given a session cookie string and expected username, returns the
 * account's followers and following.
 *
 * Always resolves (never rejects). When stopped early,
 * meta.stopped_early === true and meta.stop_reason carries
 * a FailureCode you can look up in FAILURE_MODES for UI messaging.
 *
 * @param cookie   Full cookie string (sessionid=...; csrftoken=...)
 * @param username Expected @handle. Use "*" to skip username check.
 */
export async function fetchUserList(
  cookie: string,
  username: string,
): Promise<FetchResult> {
  const fetchedAt = new Date().toISOString();

  if (!cookie || !cookie.includes("sessionid=")) {
    return emptyResult(fetchedAt, "SESSION_EXPIRED");
  }

  // Verify session and resolve ig_user_id
  const profileResult = await getCurrentUserProfile(cookie);
  if (!profileResult.ok) return emptyResult(fetchedAt, profileResult.failureCode);

  const { profile } = profileResult;

  // Username sanity check (pass "*" to skip)
  if (username !== "*" && profile.username.toLowerCase() !== username.toLowerCase()) {
    console.warn(`[ig] username mismatch: session is "${profile.username}", expected "${username}"`);
    return emptyResult(fetchedAt, "USER_NOT_FOUND");
  }

  // Fetch followers first, then following sequentially.
  // Running in parallel doubles the request burst rate and triggers Instagram
  // anti-bot throttling much sooner, cutting off pagination prematurely.
  const followersRes = await fetchEdgeList(profile.ig_id, "followers", cookie);
  await sleep(randomBetween(DIRECTION_GAP_MIN, DIRECTION_GAP_MAX));
  const followingRes = await fetchEdgeList(profile.ig_id, "following", cookie);

  const stoppedEarly = !followersRes.isComplete || !followingRes.isComplete;
  const stopReason: FailureCode | null = followersRes.stopReason ?? followingRes.stopReason ?? null;

  return {
    followers: followersRes.edges,
    following: followingRes.edges,
    meta: {
      ig_user_id:              profile.ig_id,
      username:                profile.username,
      follower_count_api:      profile.follower_count,
      following_count_api:     profile.following_count,
      post_count_api:          profile.post_count,
      follower_pages_fetched:  followersRes.pagesFetched,
      following_pages_fetched: followingRes.pagesFetched,
      is_followers_complete:   followersRes.isComplete,
      is_following_complete:   followingRes.isComplete,
      stopped_early:           stoppedEarly,
      stop_reason:             stopReason,
      fetched_at:              fetchedAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Internal helper
// ─────────────────────────────────────────────────────────────

function emptyResult(fetchedAt: string, stopReason: FailureCode): FetchResult {
  return {
    followers: [],
    following: [],
    meta: {
      ig_user_id: "", username: "",
      follower_count_api: 0, following_count_api: 0, post_count_api: 0,
      follower_pages_fetched: 0, following_pages_fetched: 0,
      is_followers_complete: false, is_following_complete: false,
      stopped_early: true, stop_reason: stopReason,
      fetched_at: fetchedAt,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Public: validate session + resolve current user identity
// ─────────────────────────────────────────────────────────────

/**
 * Validates the session cookie and returns the current user's
 * ig_id (numeric string) and username.
 *
 * Throws a plain Error if the session is invalid or Instagram
 * requires a challenge, so callers can return a 401/403 response.
 */
export async function getIgCurrentUser(
  cookie: string,
): Promise<ProfileInfo> {
  const result = await getCurrentUserProfile(cookie);
  if (!result.ok) {
    throw new Error(`instagram:${result.failureCode}`);
  }
  return result.profile;
}
