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
import { AppError, Errors } from "./errors.ts";

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

/**
 * Rotate through realistic Instagram Android app versions + devices.
 * A fixed User-Agent across all users is a fingerprint — vary it per request.
 */
const USER_AGENTS = [
  "Instagram 314.0.0.35.109 Android (26/8.0.0; 480dpi; 1080x1920; OnePlus; ONEPLUS A5000; OnePlus5; qcom; en_US; 556543836)",
  "Instagram 310.0.0.40.119 Android (28/9.0; 420dpi; 1080x2220; samsung; SM-G965F; star2lte; samsungexynos9810; en_US; 549571859)",
  "Instagram 312.0.0.34.111 Android (29/10.0; 560dpi; 1440x3040; samsung; SM-G975U; beyond2q; qcom; en_US; 551874836)",
  "Instagram 308.0.0.41.122 Android (31/12; 440dpi; 1080x2400; Google; Pixel 5; redfin; redfin; en_US; 547489008)",
  "Instagram 315.0.0.30.109 Android (33/13.0; 400dpi; 1080x2400; Google; Pixel 7; panther; panther; en_US; 558471039)",
];

/** Hard page cap per direction per run.
 *  big_list accounts return ~20 users/page on the followers endpoint,
 *  so 800 followers needs ~40 pages. 60 handles up to ~1 200 followers. */
const MAX_PAGES = 60;
const PAGE_SIZE = 200;

const BACKOFF_BASE_MS = 2_000;
const BACKOFF_MAX_MS  = 32_000;
const BACKOFF_JITTER  = 1_000;
const MAX_RETRIES     = 4;

/** Polite inter-page pause: 10 000–15 000 ms randomised. */
const PAGE_DELAY_MIN  = 10_000;
const PAGE_DELAY_MAX  = 15_000;

/** Start-delay for the second parallel direction. Separates the first page
 *  requests so Instagram doesn't see a simultaneous burst from the same session.
 *  Both fetches still run concurrently, keeping total time well under 150 s. */
const DIRECTION_START_STAGGER_MIN = 8_000;
const DIRECTION_START_STAGGER_MAX = 12_000;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function extractCsrf(cookie: string): string {
  return cookie.match(/csrftoken=([^;\s]+)/)?.[1] ?? "";
}

function buildHeaders(cookie: string): HeadersInit {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  return {
    "User-Agent":           ua,
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

/**
 * Returns a random page size between 100–200 per request.
 * Real Instagram app varies this naturally — always requesting 200 is a bot signal.
 */
function randomPageSize(): number {
  return randomBetween(100, 200);
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
    const qs = new URLSearchParams({ count: String(randomPageSize()) });
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
        // Log full response keys so we can diagnose what Instagram is returning
        const bodyKeys = Object.keys(result.body).join(", ");
        console.warn(`[ig] ${direction} page ${page}: big_list=true, no cursor. Body keys: ${bodyKeys}`);

        // Big-list retry: wait 10–15 s and replay with a fresh rank_token.
        // Instagram sometimes withholds the cursor on one response but gives it
        // back on a retry from the same position.
        if (page < MAX_PAGES) {
          const freshToken = newRankToken(igUserId);
          await sleep(randomBetween(10_000, 15_000));

          const retryQs = new URLSearchParams({ count: String(randomPageSize()) });
          retryQs.set("rank_token", freshToken);
          // Use the last cursor we had (nextMaxId is null here, so omit max_id —
          // this re-fetches relative to the last known offset via rank_token).
          const retryUrl = `${IG_API}/friendships/${igUserId}/${direction}/?${retryQs.toString()}`;
          const retryResult = await igGetWithRetry(retryUrl, cookie);
          if (retryResult.ok) {
            const retryCursor = retryResult.body.next_max_id
              ?? (retryResult.body.page_info as Record<string, unknown> | undefined)?.end_cursor
              ?? null;
            if (retryCursor && String(retryCursor).length > 0 && retryCursor !== "0" && retryCursor !== 0) {
              console.log(`[ig] ${direction} page ${page}: big_list retry succeeded, got cursor`);
              nextMaxId = String(retryCursor);
              // Don't stop — continue the loop with the new cursor
              await sleep(randomBetween(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
              continue;
            }
          }
          console.warn(`[ig] ${direction} page ${page}: big_list retry also had no cursor — stopping at ${edges.length} edges`);
        }
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
// Public: chunked edge fetcher (for resumable snapshot jobs)
// ─────────────────────────────────────────────────────────────

export interface ChunkedFetchOptions {
  /** Resume from this cursor (next_max_id from a previous invocation). */
  startCursor?: string | null;
  /** Stop after this many ms (wall-clock, measured from call time). */
  timeBudgetMs?: number;
  /** Safety cap: stop after this many pages regardless of time. */
  maxPages?: number;
}

export interface ChunkedFetchResult {
  edges: IgEdge[];
  /** Non-null means more pages exist — pass back as startCursor next time. */
  nextCursor: string | null;
  isComplete: boolean;
  pagesFetched: number;
  stopReason: FailureCode | null;
}

/**
 * Fetches one chunk of the followers or following list.
 *
 * Unlike `fetchEdgeList` (which runs until completion), this function
 * respects `timeBudgetMs` and `maxPages` so it can be called repeatedly
 * across multiple Edge Function invocations.
 *
 * Pass the returned `nextCursor` back as `startCursor` on the next call
 * to resume exactly where this one ended.
 */
export async function fetchEdgeListChunked(
  igUserId: string,
  direction: "followers" | "following",
  cookie: string,
  options: ChunkedFetchOptions = {},
): Promise<ChunkedFetchResult> {
  const {
    startCursor = null,
    timeBudgetMs = 70_000,
    maxPages = 50,
  } = options;

  const deadline   = Date.now() + timeBudgetMs;
  const rankToken  = newRankToken(igUserId);
  const edges: IgEdge[] = [];
  let nextMaxId    = startCursor;
  let page         = 0;

  // Warmup: on fresh start (not resuming from a cursor), make a cheap profile
  // request before hitting the friends list endpoint. Real Instagram app always
  // fetches the current user profile before paginating friendships — skipping
  // this cold jump onto the friendships API looks robotic.
  if (!startCursor) {
    await igGet(`${IG_API}/accounts/current_user/?edit=true`, cookie);
    await sleep(randomBetween(1_500, 3_000)); // natural navigation delay
  }

  while (page < maxPages) {
    // Time-budget check before each page fetch
    if (Date.now() >= deadline) {
      console.log(`[ig-chunked] ${direction}: time budget hit at page ${page} (${edges.length} edges)`);
      return { edges, nextCursor: nextMaxId, isComplete: false, pagesFetched: page, stopReason: null };
    }

    const qs = new URLSearchParams({ count: String(PAGE_SIZE) });
    qs.set("rank_token", rankToken);
    if (nextMaxId) qs.set("max_id", nextMaxId);

    const url = `${IG_API}/friendships/${igUserId}/${direction}/?${qs.toString()}`;
    const result = await igGetWithRetry(url, cookie);

    if (!result.ok) {
      console.warn(`[ig-chunked] ${direction} page ${page + 1} failed: ${result.failureCode}`);
      return { edges, nextCursor: nextMaxId, isComplete: false, pagesFetched: page, stopReason: result.failureCode };
    }

    const users = (result.body.users ?? result.body.items ?? []) as Array<Record<string, unknown>>;
    if (!Array.isArray(users)) {
      return { edges, nextCursor: nextMaxId, isComplete: false, pagesFetched: page, stopReason: "SUSPICIOUS_RESPONSE" };
    }

    for (const u of users) {
      edges.push({ ig_id: String(u.pk ?? u.id ?? ""), username: String(u.username ?? "") });
    }
    page++;

    console.log(`[ig-chunked] ${direction} page ${page}: got ${users.length} (total ${edges.length}), big_list=${result.body.big_list ?? false}`);

    // Resolve next cursor — check next_max_id then page_info.end_cursor
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
        // big_list retry: wait and re-request with a fresh token
        const freshToken = newRankToken(igUserId);
        await sleep(randomBetween(8_000, 12_000));
        const retryQs = new URLSearchParams({ count: String(randomPageSize()) });
        retryQs.set("rank_token", freshToken);
        const retryResult = await igGetWithRetry(
          `${IG_API}/friendships/${igUserId}/${direction}/?${retryQs.toString()}`, cookie
        );
        if (retryResult.ok) {
          const rc = retryResult.body.next_max_id
            ?? (retryResult.body.page_info as Record<string, unknown> | undefined)?.end_cursor
            ?? null;
          if (rc && String(rc).length > 0 && rc !== "0" && rc !== 0) {
            nextMaxId = String(rc);
            await sleep(randomBetween(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
            continue;
          }
        }
        console.warn(`[ig-chunked] ${direction} page ${page}: big_list, no cursor after retry — stopping at ${edges.length}`);
      }
      return { edges, nextCursor: null, isComplete: !bigList, pagesFetched: page, stopReason: bigList ? "PAGE_LIMIT_REACHED" : null };
    }

    await sleep(randomBetween(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
  }

  console.warn(`[ig-chunked] ${direction}: maxPages (${maxPages}) hit, stopped at ${edges.length}`);
  return { edges, nextCursor: nextMaxId, isComplete: false, pagesFetched: page, stopReason: "PAGE_LIMIT_REACHED" };
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

  // Fetch both directions in parallel but stagger the start of the second
  // by 8–12 s. This avoids a simultaneous page-1 burst (which triggers
  // Instagram throttling) while keeping total runtime well under the 150 s
  // Edge Function limit.
  const [followersRes, followingRes] = await Promise.all([
    fetchEdgeList(profile.ig_id, "followers", cookie),
    sleep(randomBetween(DIRECTION_START_STAGGER_MIN, DIRECTION_START_STAGGER_MAX)).then(() =>
      fetchEdgeList(profile.ig_id, "following", cookie)
    ),
  ]);

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
 * Throws an AppError with the appropriate code so callers can
 * return a properly typed error response (not a generic 500).
 */
export async function getIgCurrentUser(
  cookie: string,
): Promise<ProfileInfo> {
  const result = await getCurrentUserProfile(cookie);
  if (!result.ok) {
    switch (result.failureCode) {
      case "SESSION_EXPIRED":
        throw Errors.igSessionInvalid();
      case "CHALLENGE_REQUIRED":
      case "CHECKPOINT_REQUIRED":
        throw Errors.igChallenge();
      case "IG_RATE_LIMITED":
        throw Errors.igRateLimit();
      default:
        throw new AppError(
          result.failureCode,
          `Instagram error: ${result.failureCode}`,
          503,
        );
    }
  }
  return result.profile;
}
