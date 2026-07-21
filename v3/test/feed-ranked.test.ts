import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import type { StoredStory } from "../src/newsroom";

const BASE = "https://wire.databased.business";
const session = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const story = (id: string, desk: string, over: Partial<StoredStory> = {}): StoredStory => ({
  story_id: id, embedding: null, desk, title: `${desk} story ${id}`, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});

describe("ranked feed", () => {
  it("signed-out is chronological (ranked:false)", async () => {
    const res = await SELF.fetch(`${BASE}/api/feed/latest?limit=5`);
    const b = (await res.json()) as Record<string, any>;
    expect(b.ranked).toBe(false);
  });

  it("signed-in is ranked, carries a why, and floats priority-3 to the top", async () => {
    const ns = (env as Record<string, any>).NEWSROOM;
    const nr = ns.get(ns.idFromName("main")) as any;
    // A high-desk-weight story, a plain one, and an urgent priority-3.
    await nr.ingestBatch([
      story("rk-markets", "markets", { salience: 60 }),
      story("rk-gaming", "gaming", { salience: 60 }),
      story("rk-urgent", "weather", { priority: 3, salience: 90 }),
    ]);

    const uid = "apple:rank-tester";
    // Give this user a heavy markets desk weight via a Persona signal.
    const ps = (env as Record<string, any>).PROFILES;
    const p = ps.get(ps.idFromName(uid)) as any;
    for (let i = 0; i < 5; i++) await p.recordSignal({ sourceApp: "wire", type: "story.starred", entity: "markets" });

    const res = await SELF.fetch(`${BASE}/api/feed/latest?limit=50`, { headers: { cookie: await session(uid) } });
    const b = (await res.json()) as Record<string, any>;
    expect(b.ranked).toBe(true);
    expect(b.items[0].id).toBe("rk-urgent"); // priority-3 outranks taste
    expect(b.items[0]).toHaveProperty("rankWhy");
    expect(b.items[0]).toHaveProperty("rankScore");

    // Among the non-urgent stories, the heavy-weight markets desk outranks gaming.
    const nonUrgent = b.items.filter((i: any) => i.id !== "rk-urgent");
    const mi = nonUrgent.findIndex((i: any) => i.id === "rk-markets");
    const gi = nonUrgent.findIndex((i: any) => i.id === "rk-gaming");
    expect(mi).toBeLessThan(gi);
  });

  it("?order=latest opts a signed-in user back into chronological", async () => {
    const res = await SELF.fetch(`${BASE}/api/feed/latest?order=latest`, { headers: { cookie: await session("apple:rank-tester") } });
    const b = (await res.json()) as Record<string, any>;
    expect(b.ranked).toBe(false);
  });
});
