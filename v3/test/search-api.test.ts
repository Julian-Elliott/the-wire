import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";

// Integration: the test env has NO env.AI (hermetic), so /api/search and the
// saved-search feed-join run LEXICAL-ONLY (ai:false) — which also proves the
// AI-absent degrade end-to-end. Semantic behaviour is unit-tested in search.test.ts.

const BASE = "https://wire.databased.business";
const cookie = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
const profile = (uid: string) => {
  const ns = (env as Record<string, any>).PROFILES;
  return ns.get(ns.idFromName(uid)) as any;
};
const ingest = (rows: any[]) => {
  const ns = (env as Record<string, any>).NEWSROOM;
  return (ns.get(ns.idFromName("main")) as any).ingestBatch(rows);
};
const story = (id: string, desk: string, title: string, over: Record<string, any> = {}) => ({
  story_id: id, embedding: null, audience: null, desk, title, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});
const getj = async (uid: string, path: string, init: any = {}) => {
  const { headers = {}, ...rest } = init;
  return (await (await SELF.fetch(`${BASE}${path}`, { headers: { cookie: await cookie(uid), ...headers }, ...rest })).json()) as Record<string, any>;
};
const post = (uid: string, path: string, body: any) =>
  getj(uid, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Instant search endpoint", () => {
  it("requires a session and short-circuits a short query", async () => {
    expect((await SELF.fetch(`${BASE}/api/search?q=flood`)).status).toBe(401);
    const b = await getj("apple:s-short", "/api/search?q=a");
    expect(b).toMatchObject({ ok: true, count: 0 });
  });

  it("finds by words and reports ai:false when AI is absent", async () => {
    await ingest([story("sa-flood", "world", "Yorkshire flooding closes rail line"), story("sa-cricket", "sport", "County cricket final")]);
    const b = await getj("apple:s-lex", "/api/search?q=flooding");
    expect(b.ok).toBe(true);
    expect(b.ai).toBe(false);
    expect(b.items.some((i: any) => i.id === "sa-flood")).toBe(true);
    const none = await getj("apple:s-lex", "/api/search?q=zebra");
    expect(none.count).toBe(0);
  });

  it("entity echo matches whole words only, never a substring (Iran ≠ Miranda)", async () => {
    await (env as Record<string, any>).KV.put("ent:persiax", "Iran"); // a short canonical label
    await ingest([story("ee-iran", "world", "Iran signs a new accord"), story("ee-miranda", "world", "Miranda rights case argued")]);
    const b = await getj("apple:ee", "/api/search?q=persiax");
    expect(b.resolvedTo).toBe("Iran");
    const ids = (b.items || []).map((i: any) => i.id);
    expect(ids).toContain("ee-iran"); // whole word "iran" present
    expect(ids).not.toContain("ee-miranda"); // "iran" only inside "Miranda" ⇒ excluded
  });

  it("honours the privacy gate — never another user's audience-scoped story", async () => {
    await ingest([story("sa-secret", "world", "Secret widget recall notice", { audience: "apple:userB" })]);
    const asA = await getj("apple:userA", "/api/search?q=widget");
    expect(asA.items.some((i: any) => i.id === "sa-secret")).toBe(false); // A must never see B's scoped story
    const asB = await getj("apple:userB", "/api/search?q=widget");
    expect(asB.items.some((i: any) => i.id === "sa-secret")).toBe(true);
  });
});

describe("Saved-search CRUD", () => {
  it("adds, dedups, caps, reweights, removes — and never emits a vector", async () => {
    const uid = "apple:s-crud";
    const add = await post(uid, "/api/me/searches", { q: "tesla" });
    expect(add.ok).toBe(true);
    expect(add.searches).toEqual([{ id: expect.any(String), q: "tesla", weight: 1 }]);
    expect(JSON.stringify(add.searches)).not.toContain("vec");

    expect((await post(uid, "/api/me/searches", { q: "Tesla!" })).reason).toBe("duplicate");

    for (const q of ["a1", "b2", "c3", "d4", "e5", "f6", "g7"]) await post(uid, "/api/me/searches", { q });
    expect((await post(uid, "/api/me/searches", { q: "overflow9" })).reason).toBe("cap"); // 8 max

    const id = add.searches[0].id;
    const rew = await post(uid, "/api/me/searches", { id, weight: 3 });
    expect(rew.searches.find((s: any) => s.id === id).weight).toBe(3);
    const rem = await post(uid, "/api/me/searches", { id, weight: 0 });
    expect(rem.searches.some((s: any) => s.id === id)).toBe(false);
  });

  it("a malformed adjust (missing weight) is rejected, never a silent delete", async () => {
    const uid = "apple:s-guard";
    const add = await post(uid, "/api/me/searches", { q: "keepme" });
    const id = add.searches[0].id;
    const res = await SELF.fetch(`${BASE}/api/me/searches`, {
      method: "POST", headers: { cookie: await cookie(uid), "content-type": "application/json" },
      body: JSON.stringify({ id }), // no weight
    });
    expect(res.status).toBe(400);
    expect((await getj(uid, "/api/me/desks")).searches.some((s: any) => s.id === id)).toBe(true); // still there
  });

  it("surfaces saved searches on /api/me/desks without vectors", async () => {
    const uid = "apple:s-list";
    await post(uid, "/api/me/searches", { q: "solar" });
    const d = await getj(uid, "/api/me/desks");
    expect(d.searches[0]).toMatchObject({ q: "solar", weight: 1 });
    expect(JSON.stringify(d.searches)).not.toContain("vec");
  });
});

describe("ProfileDO saved-search round-trip", () => {
  it("stores vec + weight, dedups, clamps, removes, onboards, and erases", async () => {
    const p = profile("apple:s-do");
    const r = await p.addSearch("tesla", [0.1, 0.2, 0.3], 2);
    expect(r.added).toBe(true);
    const list = await p.getSearches();
    expect(list[0]).toMatchObject({ q: "tesla", weight: 2 });
    expect(list[0].vec).toEqual([0.1, 0.2, 0.3]);
    expect((await p.addSearch("Tesla!", null)).reason).toBe("duplicate"); // normalised dedup
    expect((await p.getFollowState()).onboarded).toBe(true); // a saved search onboards
    const id = list[0].id;
    expect((await p.setSearchWeight(id, 9))[0].weight).toBe(3); // clamp
    expect(await p.setSearchWeight(id, 0)).toEqual([]); // remove
    await p.addSearch("again", null);
    await p.purge();
    expect(await p.getSearches()).toEqual([]); // erasure
  });
});

describe("Saved searches JOIN the feed", () => {
  it("includes matches (tagged), dedups a followed-desk match, excludes non-matches", async () => {
    await ingest([
      story("sj-hit", "markets", "widget maker soars on new orders"),
      story("sj-miss", "markets", "unrelated banking merger completes"),
      story("sj-world", "world", "world widget summit opens"),
    ]);
    const uid = "apple:s-join";
    await profile(uid).setFollow("world", 1); // follows ONLY world
    await post(uid, "/api/me/searches", { q: "widget" });
    const feed = await getj(uid, "/api/feed/latest?limit=100");
    const byId = Object.fromEntries((feed.items || []).map((i: any) => [i.id, i]));
    expect(byId["sj-hit"]).toBeTruthy();
    expect(byId["sj-hit"].searchQ).toBe("widget"); // search-only join → tagged
    expect(byId["sj-world"]).toBeTruthy();
    expect(byId["sj-world"].searchQ).toBeUndefined(); // followed desk wins → no double-badge
    expect(byId["sj-miss"]).toBeUndefined(); // no match, not followed → absent
  });

  it("a brand-new user who saves a search is onboarded and sees the match", async () => {
    await ingest([story("so-hit", "markets", "quantum widget breakthrough")]);
    const uid = "apple:s-onboard";
    expect((await getj(uid, "/api/feed/latest?limit=100")).onboarding).toBe(true); // never-chose
    await post(uid, "/api/me/searches", { q: "quantum" });
    const feed = await getj(uid, "/api/feed/latest?limit=100");
    expect(feed.onboarding).toBe(false); // saving a search onboarded them
    expect((feed.items || []).some((i: any) => i.id === "so-hit")).toBe(true);
  });
});
