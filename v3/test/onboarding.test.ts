import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import type { StoredStory } from "../src/newsroom";

// First run: topics are CHOSEN not DEFAULT (PRODUCT_DIRECTION Wave A #3).
// The silent lazy-seed is gone: getFollows() never writes, and a brand-new
// user is diverted to the inline chooser instead of the all-desks firehose.

const BASE = "https://wire.databased.business";
const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const profile = (uid: string) => {
  const ns = (env as Record<string, any>).PROFILES;
  return ns.get(ns.idFromName(uid)) as any;
};

const ingest = (rows: StoredStory[]) => {
  const ns = (env as Record<string, any>).NEWSROOM;
  return (ns.get(ns.idFromName("main")) as any).ingestBatch(rows);
};

const story = (id: string, desk: string, over: Partial<StoredStory> = {}): StoredStory => ({
  story_id: id, embedding: null, desk, title: `${desk} ${id}`, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});

const getJson = async (uid: string, path: string) =>
  (await (await SELF.fetch(`${BASE}${path}`, { headers: { cookie: await session(uid) } })).json()) as Record<string, any>;

describe("ProfileDO follow-state seam (no silent write-on-read)", () => {
  it("a brand-new user is not onboarded, has empty follows, and getFollows() never onboards them", async () => {
    const p = profile("apple:onb-new");
    expect(await p.getFollowState()).toEqual({ follows: {}, onboarded: false });
    await p.getFollows(); // pure read — must NOT persist a {} row or a marker
    expect((await p.getFollowState()).onboarded).toBe(false);
  });

  it("a v2-migrated user is already onboarded (no first-run), derived without persisting", async () => {
    const p = profile("apple:onb-v2");
    await p.importV2({ config: { desks: { enabled: ["world", "ev"] } } });
    expect(await p.getFollowState()).toEqual({ follows: { world: 1, ev: 1 }, onboarded: true });
  });

  it("the first pick onboards; unfollowing back to nothing reads as chose-nothing, not never-chose", async () => {
    const p = profile("apple:onb-pick");
    await p.setFollow("world", 1);
    expect(await p.getFollowState()).toEqual({ follows: { world: 1 }, onboarded: true });
    await p.setFollow("world", 0); // untap the only pick
    expect(await p.getFollowState()).toEqual({ follows: {}, onboarded: true }); // stays onboarded
  });

  it("markOnboarded with zero picks = deliberately chose nothing", async () => {
    const p = profile("apple:onb-zero");
    await p.markOnboarded();
    expect(await p.getFollowState()).toEqual({ follows: {}, onboarded: true });
  });
});

describe("Feed endpoint drives first run", () => {
  it("a brand-new user's feed reports onboarding:true and STAYS true after a fetch", async () => {
    await ingest([story("of-a", "world"), story("of-b", "ev")]);
    const uid = "apple:onb-feed-new";
    expect((await getJson(uid, "/api/feed/latest?limit=100")).onboarding).toBe(true);
    // Fetching the feed must not silently onboard them (the old seed did).
    expect((await getJson(uid, "/api/feed/latest?limit=100")).onboarding).toBe(true);
  });

  it("an onboarded user with no chosen topics sees ONLY urgent — never the firehose", async () => {
    await ingest([story("oe-plain", "world"), story("oe-urgent", "weather", { priority: 3, salience: 90 })]);
    const uid = "apple:onb-empty";
    await profile(uid).markOnboarded();
    const b = await getJson(uid, "/api/feed/latest?limit=100");
    expect(b.onboarding).toBe(false);
    const desks = b.items.map((i: any) => i.desk);
    expect(desks).not.toContain("world"); // no default firehose
    expect(desks).toContain("weather"); // urgent always reaches
  });

  it("choosing a topic filters the feed and clears first-run", async () => {
    await ingest([story("oc-world", "world"), story("oc-gaming", "gaming")]);
    const uid = "apple:onb-chosen";
    await SELF.fetch(`${BASE}/api/me/desks`, {
      method: "POST", headers: { cookie: await session(uid), "content-type": "application/json" },
      body: JSON.stringify({ desk: "world", weight: 1 }),
    });
    const b = await getJson(uid, "/api/feed/latest?limit=100");
    expect(b.onboarding).toBe(false);
    const desks = b.items.map((i: any) => i.desk);
    expect(desks).toContain("world");
    expect(desks).not.toContain("gaming");
  });

  it("a v2 user skips first-run and sees their enabled desks", async () => {
    await ingest([story("ov-markets", "markets"), story("ov-gaming", "gaming")]);
    const uid = "apple:onb-v2feed";
    await profile(uid).importV2({ config: { desks: { enabled: ["markets"] } } });
    const b = await getJson(uid, "/api/feed/latest?limit=100");
    expect(b.onboarding).toBe(false);
    const desks = b.items.map((i: any) => i.desk);
    expect(desks).toContain("markets");
    expect(desks).not.toContain("gaming");
  });
});

describe("/api/me/desks onboarding flag", () => {
  it("reports onboarded:false for a new user, true after a pick", async () => {
    const uid = "apple:onb-desks";
    expect((await getJson(uid, "/api/me/desks")).onboarded).toBe(false);
    await SELF.fetch(`${BASE}/api/me/desks`, {
      method: "POST", headers: { cookie: await session(uid), "content-type": "application/json" },
      body: JSON.stringify({ desk: "world", weight: 1 }),
    });
    expect((await getJson(uid, "/api/me/desks")).onboarded).toBe(true);
  });

  it("a desk-less {onboarded:true} POST persists the marker (zero-pick Start reading)", async () => {
    const uid = "apple:onb-startzero";
    const res = await SELF.fetch(`${BASE}/api/me/desks`, {
      method: "POST", headers: { cookie: await session(uid), "content-type": "application/json" },
      body: JSON.stringify({ onboarded: true }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
    const g = await getJson(uid, "/api/me/desks");
    expect(g.onboarded).toBe(true);
    expect(g.follows).toEqual({});
  });
});

describe("Catch-up refuses the firehose during first run", () => {
  it("a not-yet-onboarded user's catch-up is urgent-only", async () => {
    await ingest([story("occ-plain", "world"), story("occ-urgent", "weather", { priority: 3, salience: 90 })]);
    const b = await getJson("apple:onb-catchup", "/api/feed/catchup");
    expect(b.ok).toBe(true);
    const ids = (b.items || []).map((i: any) => i.id);
    expect(ids).not.toContain("occ-plain"); // firehose refused
    expect(b.items.every((i: any) => i.priority === 3)).toBe(true);
  });
});
