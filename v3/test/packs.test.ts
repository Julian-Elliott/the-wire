import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";

// Starter packs (Wave B): one tap follows a curated bundle, still "all chosen".
const BASE = "https://wire.databased.business";
const cookie = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
const profile = (uid: string) => { const ns = (env as Record<string, any>).PROFILES; return ns.get(ns.idFromName(uid)) as any; };
const getj = async (uid: string, path: string) =>
  (await (await SELF.fetch(`${BASE}${path}`, { headers: { cookie: await cookie(uid) } })).json()) as Record<string, any>;
const post = async (uid: string, body: any) =>
  await SELF.fetch(`${BASE}/api/me/desks`, { method: "POST", headers: { cookie: await cookie(uid), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("Starter packs", () => {
  it("GET /api/me/desks lists curated packs", async () => {
    const d = await getj("apple:pack-list", "/api/me/desks");
    expect(Array.isArray(d.packs)).toBe(true);
    expect(d.packs.length).toBeGreaterThan(0);
    const p0 = d.packs[0];
    expect(p0).toHaveProperty("id");
    expect(p0).toHaveProperty("label");
    expect(Array.isArray(p0.desks)).toBe(true);
    expect(p0.desks.length).toBeGreaterThan(0);
  });

  it("following a pack follows all its desks in one call and onboards", async () => {
    const uid = "apple:pack-follow";
    const list = await getj(uid, "/api/me/desks");
    const pack = list.packs.find((p: any) => p.id === "money") || list.packs[0];
    const res = await post(uid, { pack: pack.id });
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(b.ok).toBe(true);
    for (const d of pack.desks) expect(b.follows[d]).toBe(1); // each desk followed at weight 1
    expect((await profile(uid).getFollowState()).onboarded).toBe(true); // a pack is a real choice
  });

  it("following a pack is additive — never downgrades a desk you set higher", async () => {
    const uid = "apple:pack-additive";
    await post(uid, { desk: "business", weight: 3 }); // you set business to Lots
    const b = (await (await post(uid, { pack: "money" })).json()) as any; // money includes business
    expect(b.follows.business).toBe(3); // preserved, NOT reset to 1
    expect(b.follows.markets).toBe(1); // newly added at Some
    expect(b.follows.energy).toBe(1);
  });

  it("an unknown pack id is rejected", async () => {
    const res = await post("apple:pack-bad", { pack: "does-not-exist" });
    expect(res.status).toBe(400);
    expect((await res.json() as any).ok).toBe(false);
  });

  it("a pack filters the feed to its desks (chosen, not defaulted)", async () => {
    const uid = "apple:pack-feed";
    const ns = (env as Record<string, any>).NEWSROOM;
    const nr = ns.get(ns.idFromName("main")) as any;
    const story = (id: string, desk: string) => ({
      story_id: id, embedding: null, audience: null, desk, title: `${desk} ${id}`, summary: "s", why: null,
      url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
      sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
      added_at: new Date().toISOString(),
    });
    await nr.ingestBatch([story("pf-mk", "markets"), story("pf-gm", "gaming")]);
    await post(uid, { pack: "money" }); // money = business, markets, energy
    const feed = await getj(uid, "/api/feed/latest?limit=100");
    const desks = (feed.items || []).map((i: any) => i.desk);
    expect(feed.onboarding).toBe(false); // pack onboarded them
    expect(desks).toContain("markets"); // in the money pack
    expect(desks).not.toContain("gaming"); // not in the pack, not followed
  });
});
