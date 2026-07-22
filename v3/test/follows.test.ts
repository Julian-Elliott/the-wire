import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import type { StoredStory } from "../src/newsroom";

const BASE = "https://wire.databased.business";
const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const profile = (uid: string) => {
  const ns = (env as Record<string, any>).PROFILES;
  return ns.get(ns.idFromName(uid)) as any;
};

const story = (id: string, desk: string, over: Partial<StoredStory> = {}): StoredStory => ({
  story_id: id, embedding: null, desk, title: `${desk} ${id}`, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});

describe("ProfileDO follows", () => {
  it("seeds from migrated v2 enabled desks, then edits durably", async () => {
    const p = profile("apple:follow-seed");
    await p.importV2({ config: { desks: { enabled: ["markets", "gaming"] } } });
    expect(await p.getFollows()).toEqual({ markets: 1, gaming: 1 });

    await p.setFollow("markets", 3); // stronger
    await p.setFollow("gaming", 0); // unfollow
    await p.setFollow("ev", 2); // new follow
    expect(await p.getFollows()).toEqual({ markets: 3, ev: 2 });
  });

  it("clamps weight to 1..3 and sanitises the desk id", async () => {
    const p = profile("apple:follow-clamp");
    await p.importV2({ config: { desks: { enabled: [] } } });
    await p.setFollow("world", 9);
    await p.setFollow("../evil", 1);
    const f = await p.getFollows();
    expect(f.world).toBe(3);
    expect(Object.keys(f)).not.toContain("../evil");
  });
});

describe("/api/me/desks routes", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/me/desks`)).status).toBe(401);
  });

  it("returns follows + available desks and updates on POST", async () => {
    const uid = "apple:follow-routes";
    const ck = await session(uid);
    await profile(uid).importV2({ config: { desks: { enabled: ["world"] } } });

    const get = await SELF.fetch(`${BASE}/api/me/desks`, { headers: { cookie: ck } });
    const g = (await get.json()) as Record<string, any>;
    expect(g.follows).toEqual({ world: 1 });
    expect(Array.isArray(g.available)).toBe(true);

    const post = await SELF.fetch(`${BASE}/api/me/desks`, {
      method: "POST", headers: { "content-type": "application/json", cookie: ck },
      body: JSON.stringify({ desk: "markets", weight: 2 }),
    });
    expect(((await post.json()) as any).follows).toEqual({ world: 1, markets: 2 });
  });
});

describe("ranked feed honours follows", () => {
  it("hides unfollowed desks (but never priority-3) and follow-weights the rest", async () => {
    const ns = (env as Record<string, any>).NEWSROOM;
    const nr = ns.get(ns.idFromName("main")) as any;
    await nr.ingestBatch([
      story("fw-markets", "markets"),
      story("fw-gaming", "gaming"),
      story("fw-urgent", "weather", { priority: 3, salience: 90 }),
    ]);

    const uid = "apple:follow-feed";
    const ck = await session(uid);
    // Follow markets only.
    await profile(uid).importV2({ config: { desks: { enabled: [] } } });
    await profile(uid).setFollow("markets", 2);

    const res = await SELF.fetch(`${BASE}/api/feed/latest?limit=100`, { headers: { cookie: ck } });
    const b = (await res.json()) as Record<string, any>;
    const desks = b.items.map((i: any) => i.desk);
    expect(desks).toContain("markets");
    expect(desks).not.toContain("gaming"); // unfollowed → hidden
    expect(desks).toContain("weather"); // priority-3 survives the filter
    expect(b.items[0].desk).toBe("weather"); // urgency still tops
  });
});
