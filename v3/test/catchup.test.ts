import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import type { StoredStory } from "../src/newsroom";

const BASE = "https://wire.databased.business";
const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const story = (id: string, over: Partial<StoredStory> = {}): StoredStory => ({
  story_id: id, embedding: null, desk: "world", title: `Story ${id}`, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:world|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});

describe("Catch-up: the edition that ends", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/feed/catchup`)).status).toBe(401);
  });

  it("caps the edition, then marks done and reports caught-up", async () => {
    const ns = (env as Record<string, any>).NEWSROOM;
    const nr = ns.get(ns.idFromName("main")) as any;
    // 10 fresh world stories → catch-up should cap at 7.
    const now = Date.now();
    await nr.ingestBatch(
      Array.from({ length: 10 }, (_, i) =>
        story(`cu-${i}`, { added_at: new Date(now - i * 1000).toISOString(), salience: 90 - i })),
    );

    const uid = "apple:catchup-user";
    const ck = await session(uid);
    // Follow world so the ranked feed includes these.
    const p = (env as Record<string, any>).PROFILES;
    await (p.get(p.idFromName(uid)) as any).setFollow("world", 1);

    const first = await (await SELF.fetch(`${BASE}/api/feed/catchup`, { headers: { cookie: ck } })).json() as Record<string, any>;
    expect(first.caughtUp).toBe(false);
    expect(first.count).toBe(7); // capped
    expect(first.remaining).toBeGreaterThanOrEqual(1); // more exist beyond the cap
    expect(first.items).toHaveLength(7);

    // Mark done at the newest story shown.
    const done = await SELF.fetch(`${BASE}/api/feed/catchup/done`, {
      method: "POST", headers: { cookie: ck, "content-type": "application/json" },
      body: JSON.stringify({ newestAt: first.items[0].addedAt }),
    });
    expect(done.status).toBe(200);

    // Now caught up on everything up to that mark; nothing strictly newer.
    const second = await (await SELF.fetch(`${BASE}/api/feed/catchup`, { headers: { cookie: ck } })).json() as Record<string, any>;
    expect(second.caughtUp).toBe(true);
    expect(second.count).toBe(0);
    expect(second.since).toBeTruthy();
  });

  it("a brand-new story after 'done' reappears in the next catch-up", async () => {
    const uid = "apple:catchup-fresh";
    const ck = await session(uid);
    const p = (env as Record<string, any>).PROFILES;
    await (p.get(p.idFromName(uid)) as any).setFollow("world", 1);
    // Mark caught up as of now.
    await SELF.fetch(`${BASE}/api/feed/catchup/done`, {
      method: "POST", headers: { cookie: ck, "content-type": "application/json" },
      body: JSON.stringify({ newestAt: new Date().toISOString() }),
    });
    // A newer story lands.
    const ns = (env as Record<string, any>).NEWSROOM;
    await (ns.get(ns.idFromName("main")) as any).ingestBatch([
      story("cu-new", { added_at: new Date(Date.now() + 60_000).toISOString(), salience: 95 }),
    ]);
    const res = await (await SELF.fetch(`${BASE}/api/feed/catchup`, { headers: { cookie: ck } })).json() as Record<string, any>;
    expect(res.caughtUp).toBe(false);
    expect(res.items.some((i: any) => i.id === "cu-new")).toBe(true);
  });
});
