/// <reference path="../deno-types.d.ts" />
// list-users/index.ts
//
// GET /list-users?ig_account_id=<uuid>&list_type=<type>&page=<n>&search=<q>
//
// Returns a paginated list of IgUser objects for one of the five list types.
// For not_following_back / you_dont_follow_back, falls back to computing
// from the latest single snapshot when no diff exists yet.

import { corsPreflightResponse, jsonResponse } from "../_shared/cors.ts";
import { errorResponse, Errors } from "../_shared/errors.ts";
import { requireAuth, requireOwnsAccount } from "../_shared/auth.ts";
import { adminClient } from "../_shared/supabase_client.ts";

const PAGE_SIZE = 50;

/** Number of preview items free users can see per list. */
const FREE_PREVIEW_LIMIT = 10;

/**
 * Beta access: set to `true` to grant all users Pro-level list access.
 * Mirror of the client-side flag in lib/betaAccess.ts.
 * Set to `false` to restore normal freemium gating.
 */
const BETA_ACCESS_ENABLED = true;

type ListType =
  | "new_followers"
  | "lost_followers"
  | "not_following_back"
  | "you_dont_follow_back"
  | "you_unfollowed"
  | "followers"
  | "following"
  | "friends";

const VALID_LIST_TYPES: ListType[] = [
  "new_followers",
  "lost_followers",
  "not_following_back",
  "you_dont_follow_back",
  "you_unfollowed",
  "followers",
  "following",
  "friends",
];

/** List types served directly from the latest snapshot's raw JSON. */
const SNAPSHOT_BACKED_TYPES = new Set<ListType>([
  "not_following_back",
  "you_dont_follow_back",
  "followers",
  "following",
  "friends",
]);

interface IgEdge { ig_id: string; username: string; }

// Stable key: prefer numeric ig_id, fall back to @username
function edgeKey(e: IgEdge): string {
  return e.ig_id ? e.ig_id : `@${e.username.toLowerCase()}`;
}

function toMap(edges: IgEdge[]): Map<string, IgEdge> {
  const m = new Map<string, IgEdge>();
  for (const e of edges) {
    const k = edgeKey(e);
    if (k) m.set(k, e);
  }
  return m;
}

// Elements in `a` NOT present in `bMap`
function setDiff(a: IgEdge[], bMap: Map<string, IgEdge>): IgEdge[] {
  return a.filter((e) => !bMap.has(edgeKey(e)));
}

// Elements in `a` ALSO present in `bMap` (intersection by key, preserving `a` order)
function setIntersection(a: IgEdge[], bMap: Map<string, IgEdge>): IgEdge[] {
  return a.filter((e) => bMap.has(edgeKey(e)));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return corsPreflightResponse();
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireAuth(req);
    const url    = new URL(req.url);

    const igAccountId = url.searchParams.get("ig_account_id");
    const listTypeRaw = url.searchParams.get("list_type") ?? "not_following_back";
    const page        = Math.max(0, parseInt(url.searchParams.get("page") ?? "0", 10));
    const search      = (url.searchParams.get("search") ?? "").trim().toLowerCase();

    if (!igAccountId) throw Errors.badRequest("ig_account_id is required.");
    if (!VALID_LIST_TYPES.includes(listTypeRaw as ListType)) {
      throw Errors.badRequest(`list_type must be one of: ${VALID_LIST_TYPES.join(", ")}`);
    }
    const listType = listTypeRaw as ListType;

    await requireOwnsAccount(caller.authHeader, igAccountId);

    let allItems: IgEdge[] = [];

    if (SNAPSHOT_BACKED_TYPES.has(listType)) {
      // ── Latest snapshot raw JSON ──────────────────────
      // followers, following, friends, and the two reciprocity lists are
      // all derived from the most recent snapshot's followers_json and
      // following_json. We never use stored diff columns for these because
      // they go stale on every new snapshot.
      const { data: snap } = await adminClient()
        .from("follower_snapshots")
        .select("followers_json, following_json")
        .eq("ig_account_id", igAccountId)
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (snap) {
        const followers: IgEdge[] = Array.isArray(snap.followers_json)
          ? (snap.followers_json as IgEdge[])
          : [];
        const following: IgEdge[] = Array.isArray(snap.following_json)
          ? (snap.following_json as IgEdge[])
          : [];

        const followersMap = toMap(followers);
        const followingMap = toMap(following);

        switch (listType) {
          case "followers":
            allItems = followers;
            break;
          case "following":
            allItems = following;
            break;
          case "friends":
            // Mutual followers: intersection of followers and following.
            // O(followers + following) — sub-millisecond at 5k entries.
            allItems = setIntersection(following, followersMap);
            break;
          case "not_following_back":
            allItems = setDiff(following, followersMap); // you follow; they don't follow back
            break;
          case "you_dont_follow_back":
            allItems = setDiff(followers, followingMap); // they follow you; you don't follow back
            break;
        }
      }
    } else {
      // ── Change metrics: use stored diff, only if it's complete ────
      const { data: diffs } = await adminClient()
        .from("diffs")
        .select(`${listType}, is_complete`)
        .eq("ig_account_id", igAccountId)
        .order("to_captured_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (diffs && (diffs as Record<string, unknown>).is_complete === true) {
        const raw = (diffs as Record<string, unknown>)[listType];
        allItems = Array.isArray(raw) ? (raw as IgEdge[]) : [];
      }
      // incomplete diff or no diff → empty (needs two complete snapshots)
    }

    // ── Search filter ─────────────────────────────────────────
    if (search) {
      allItems = allItems.filter((u) =>
        u.username.toLowerCase().includes(search)
      );
    }

    // ── Subscription check (freemium gating) ──────────────────
    // Free users see only a preview; pro users get the full list.
    const { data: profile } = await adminClient()
      .from("profiles")
      .select("subscription_status, subscription_expires_at, promo_until")
      .eq("id", caller.userId)
      .maybeSingle();

    const dbStatus    = profile?.subscription_status ?? null;
    const dbExpiresAt = profile?.subscription_expires_at ?? null;
    const promoUntil  = profile?.promo_until ?? null;

    // Active promo that hasn't expired grants Pro access
    const promoActive = promoUntil && new Date(promoUntil) > new Date();

    const subActive   = BETA_ACCESS_ENABLED || promoActive || (
      profile
      && ["active", "trial"].includes(dbStatus ?? "")
      && (!dbExpiresAt || new Date(dbExpiresAt) > new Date())
    );
    const isFreeUser  = !subActive;

    const totalCount = allItems.length;

    // Free users only get the first FREE_PREVIEW_LIMIT items
    if (isFreeUser && allItems.length > FREE_PREVIEW_LIMIT) {
      allItems = allItems.slice(0, FREE_PREVIEW_LIMIT);
    }

    // ── Gating diagnostic (always logged — cheap, invaluable for debugging) ──
    console.log(`[list-users] gating: user=${caller.userId} status=${dbStatus} expires=${dbExpiresAt} subActive=${subActive} isFree=${isFreeUser} beta=${BETA_ACCESS_ENABLED} total=${totalCount} sent=${allItems.length}`);

    // ── Paginate ──────────────────────────────────────────────
    const start    = page * PAGE_SIZE;
    const slice    = allItems.slice(start, start + PAGE_SIZE);
    const nextPage = start + PAGE_SIZE < allItems.length ? page + 1 : null;

    return jsonResponse({
      items:      slice,
      total:      totalCount,
      page,
      next_page:  nextPage,
      is_limited: isFreeUser && totalCount > FREE_PREVIEW_LIMIT,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
