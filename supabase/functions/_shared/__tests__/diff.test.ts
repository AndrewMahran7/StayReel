/// <reference path="../../deno-types.d.ts" />
// _shared/__tests__/diff.test.ts
//
// Unit tests for computeSnapshotDiff().
// Run with: deno test --allow-none supabase/functions/_shared/__tests__/diff.test.ts
//
// No network calls, no DB — pure function tests only.

import { assertEquals, assertArrayIncludes } from "jsr:@std/assert@1";
import {
  computeSnapshotDiff,
  summariseDiff,
  IgEdge,
  SnapshotPair,
} from "../diff.ts";

// ─────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────

// Helper: build an IgEdge with a stable numeric id + username
function e(igId: string, username: string): IgEdge {
  return { ig_id: igId, username };
}

// Edge without a numeric ID (scraper-only data)
function eu(username: string): IgEdge {
  return { ig_id: "", username };
}

// ── Fixture A: small, fully-paginated account ─────────────────
// Before:
//   followers  : alice, bob, charlie
//   following  : alice, bob, dave
//
// After:
//   followers  : alice, charlie, erin  (bob left, erin joined)
//   following  : alice, dave, frank    (bob unfollowed, frank newly followed)
//
// Expected diff:
//   new_followers        : [erin]
//   lost_followers       : [bob]
//   you_unfollowed       : [bob]
//   you_newly_followed   : [frank]
//   not_following_back   : [dave, frank]   (following but not in followers)
//   you_dont_follow_back : [charlie, erin] (followers but not in following)
//   net_follower_change  : 0  (3 → 3)
//   net_following_change : 0  (3 → 3)

const fixtureA: SnapshotPair = {
  prevFollowers: [e("1", "alice"), e("2", "bob"), e("3", "charlie")],
  currFollowers: [e("1", "alice"), e("3", "charlie"), e("5", "erin")],
  prevFollowing: [e("1", "alice"), e("2", "bob"),   e("4", "dave")],
  currFollowing: [e("1", "alice"), e("4", "dave"),  e("6", "frank")],
};

// ── Fixture B: someone both unfollows and re-follows  ─────────
// Edge case: "grace" was NOT in prevFollowers but IS in currFollowers i.e. new.
// Also "henry" was in prevFollowers but NOT in currFollowers i.e. lost.

const fixtureB: SnapshotPair = {
  prevFollowers: [e("10", "henry"), e("11", "ivy")],
  currFollowers: [e("11", "ivy"),   e("12", "grace")],
  prevFollowing: [e("10", "henry"), e("11", "ivy")],
  currFollowing: [e("11", "ivy"),   e("12", "grace")],
};

// ── Fixture C: username-only edges (no ig_id) ─────────────────
// Verifies the username-fallback key strategy still produces correct diffs.

const fixtureC: SnapshotPair = {
  prevFollowers: [eu("alice"), eu("bob")],
  currFollowers: [eu("alice"), eu("carol")],
  prevFollowing: [eu("alice"), eu("dave")],
  currFollowing: [eu("alice"), eu("eve")],
};

// ── Fixture D: username renamed (ig_id same, username changed) ─
// "zara" was known as "zara_old"; same ig_id = "99".
// Should NOT appear as lost + new — it should be transparent.

const fixtureD: SnapshotPair = {
  prevFollowers: [e("99", "zara_old"), e("20", "mike")],
  currFollowers: [e("99", "zara_new"), e("20", "mike")],
  prevFollowing: [],
  currFollowing: [],
};

// ── Fixture E: empty lists (brand new account, no history) ────

const fixtureE: SnapshotPair = {
  prevFollowers: [],
  currFollowers: [e("30", "first_follower")],
  prevFollowing: [],
  currFollowing: [],
};

// ── Fixture F: incomplete lists, uses API counts for net delta ─

const fixtureF: SnapshotPair = {
  prevFollowers: [e("1", "alice")],
  currFollowers: [e("1", "alice"), e("2", "bob")],
  prevFollowing: [],
  currFollowing: [],
  prevFollowerCountApi:  8_000,  // real count from IG profile API
  currFollowerCountApi:  8_500,
  prevFollowingCountApi: 400,
  currFollowingCountApi: 405,
};

// ─────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────

// ── Fixture A ─────────────────────────────────────────────────

Deno.test("A: new_followers contains erin only", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.new_followers.map((e) => e.username), ["erin"]);
});

Deno.test("A: lost_followers contains bob only", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.lost_followers.map((e) => e.username), ["bob"]);
});

Deno.test("A: you_unfollowed contains bob only", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.you_unfollowed.map((e) => e.username), ["bob"]);
});

Deno.test("A: you_newly_followed contains frank only", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.you_newly_followed.map((e) => e.username), ["frank"]);
});

Deno.test("A: not_following_back is {dave, frank}", () => {
  const diff = computeSnapshotDiff(fixtureA);
  const names = diff.not_following_back.map((e) => e.username).sort();
  assertEquals(names, ["dave", "frank"]);
});

Deno.test("A: you_dont_follow_back is {charlie, erin}", () => {
  const diff = computeSnapshotDiff(fixtureA);
  const names = diff.you_dont_follow_back.map((e) => e.username).sort();
  assertEquals(names, ["charlie", "erin"]);
});

Deno.test("A: net_follower_change is 0 (3→3)", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.net_follower_change, 0);
});

Deno.test("A: net_following_change is 0 (3→3)", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.net_following_change, 0);
});

Deno.test("A: is_complete defaults to true", () => {
  const diff = computeSnapshotDiff(fixtureA);
  assertEquals(diff.is_complete, true);
});

Deno.test("A: is_complete false when explicitly set", () => {
  const diff = computeSnapshotDiff(fixtureA, false);
  assertEquals(diff.is_complete, false);
});

// ── Fixture B ─────────────────────────────────────────────────

Deno.test("B: henry lost (unfollowed you + you unfollowed them)", () => {
  const diff = computeSnapshotDiff(fixtureB);
  assertEquals(diff.lost_followers.map((e) => e.username), ["henry"]);
  assertEquals(diff.you_unfollowed.map((e) => e.username), ["henry"]);
});

Deno.test("B: grace is new follower", () => {
  const diff = computeSnapshotDiff(fixtureB);
  assertEquals(diff.new_followers.map((e) => e.username), ["grace"]);
});

Deno.test("B: you_newly_followed contains grace", () => {
  const diff = computeSnapshotDiff(fixtureB);
  assertEquals(diff.you_newly_followed.map((e) => e.username), ["grace"]);
});

Deno.test("B: not_following_back is empty (grace follows you and you follow grace)", () => {
  const diff = computeSnapshotDiff(fixtureB);
  assertEquals(diff.not_following_back, []);
});

// ── Fixture C: username-only (no ig_id) ───────────────────────

Deno.test("C: username-fallback key — bob is lost, carol is new", () => {
  const diff = computeSnapshotDiff(fixtureC);
  assertEquals(diff.lost_followers.map((e) => e.username), ["bob"]);
  assertEquals(diff.new_followers.map((e) => e.username), ["carol"]);
});

Deno.test("C: username-fallback — you_unfollowed dave, you_newly_followed eve", () => {
  const diff = computeSnapshotDiff(fixtureC);
  assertEquals(diff.you_unfollowed.map((e) => e.username), ["dave"]);
  assertEquals(diff.you_newly_followed.map((e) => e.username), ["eve"]);
});

// ── Fixture D: ig_id match preserves users across username change ──

Deno.test("D: renamed user (same ig_id) not counted as lost+new", () => {
  const diff = computeSnapshotDiff(fixtureD);
  // zara_old and zara_new share ig_id "99" → should NOT appear in either list
  const lostNames = diff.lost_followers.map((e) => e.username);
  const newNames  = diff.new_followers.map((e) => e.username);
  assertEquals(lostNames.includes("zara_old"), false);
  assertEquals(newNames.includes("zara_new"),  false);
  // mike is unchanged
  assertEquals(lostNames.includes("mike"), false);
  assertEquals(newNames.includes("mike"),  false);
  // both sets empty
  assertEquals(diff.lost_followers.length, 0);
  assertEquals(diff.new_followers.length,  0);
});

// ── Fixture E: first snapshot (empty prev lists) ───────────────

Deno.test("E: first snapshot — no lost followers", () => {
  const diff = computeSnapshotDiff(fixtureE);
  assertEquals(diff.lost_followers, []);
});

Deno.test("E: first snapshot — first_follower in new_followers", () => {
  const diff = computeSnapshotDiff(fixtureE);
  assertEquals(diff.new_followers[0].username, "first_follower");
});

Deno.test("E: first snapshot — net +1", () => {
  const diff = computeSnapshotDiff(fixtureE);
  assertEquals(diff.net_follower_change, 1);
});

// ── Fixture F: incomplete lists use API counts for net delta ───

Deno.test("F: net_follower_change uses API counts, not list lengths", () => {
  const diff = computeSnapshotDiff(fixtureF, false); // incomplete
  assertEquals(diff.net_follower_change,  500);  // 8500 - 8000
  assertEquals(diff.net_following_change, 5);    // 405 - 400
  assertEquals(diff.is_complete, false);
});

// ── summariseDiff ──────────────────────────────────────────────

Deno.test("summariseDiff returns correct counts for fixture A", () => {
  const diff    = computeSnapshotDiff(fixtureA);
  const summary = summariseDiff(diff);
  assertEquals(summary.new_followers_count,        1); // erin
  assertEquals(summary.lost_followers_count,       1); // bob
  assertEquals(summary.you_unfollowed_count,       1); // bob
  assertEquals(summary.you_newly_followed_count,   1); // frank
  assertEquals(summary.not_following_back_count,   2); // dave, frank
  assertEquals(summary.you_dont_follow_back_count, 2); // charlie, erin
  assertEquals(summary.net_follower_change,        0);
  assertEquals(summary.net_following_change,       0);
  assertEquals(summary.is_complete,                true);
});

// ── Edge cases ──────────────────────────────────────────────────

Deno.test("all-empty inputs produce all-empty diff", () => {
  const diff = computeSnapshotDiff({
    prevFollowers: [], currFollowers: [],
    prevFollowing: [], currFollowing: [],
  });
  assertEquals(diff.new_followers,        []);
  assertEquals(diff.lost_followers,       []);
  assertEquals(diff.you_unfollowed,       []);
  assertEquals(diff.you_newly_followed,   []);
  assertEquals(diff.not_following_back,   []);
  assertEquals(diff.you_dont_follow_back, []);
  assertEquals(diff.net_follower_change,  0);
  assertEquals(diff.net_following_change, 0);
});

Deno.test("duplicate edges in input are handled gracefully", () => {
  // Map keying deduplicates — last write wins; counts may differ from
  // input.length but sets should not contain duplicates.
  const dup = e("1", "alice");
  const diff = computeSnapshotDiff({
    prevFollowers: [dup, dup],
    currFollowers: [dup],
    prevFollowing: [],
    currFollowing: [],
  });
  // alice was in both — should not appear as lost or new
  assertEquals(diff.lost_followers.length, 0);
  assertEquals(diff.new_followers.length,  0);
});

Deno.test("ig_id takes priority over username for matching", () => {
  // Same ig_id, different usernames → same person.
  // Same username, different ig_ids → different people.
  const prev = [e("100", "shared_username")];
  const curr = [e("999", "shared_username")]; // different ig_id, same username
  const diff = computeSnapshotDiff({
    prevFollowers: prev, currFollowers: curr,
    prevFollowing: [],   currFollowing: [],
  });
  // ig_id 100 ≠ ig_id 999 → prev person is lost, curr person is new
  assertEquals(diff.lost_followers.map((e) => e.ig_id), ["100"]);
  assertEquals(diff.new_followers.map((e) => e.ig_id),  ["999"]);
});
