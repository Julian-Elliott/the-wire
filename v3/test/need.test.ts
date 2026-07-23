import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import { stakesOf, NEED_THRESHOLD, NEED_MARK_CAP } from "../src/lib/rank";

// Want/need (Wave B): need = stakes × scope, anchor-only, capped "Worth knowing".
const BASE = "https://wire.databased.business";
const cookie = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));
const profile = (uid: string) => { const ns = (env as Record<string, any>).PROFILES; return ns.get(ns.idFromName(uid)) as any; };
const ingest = (rows: any[]) => { const ns = (env as Record<string, any>).NEWSROOM; return (ns.get(ns.idFromName("main")) as any).ingestBatch(rows); };
const story = (id: string, desk: string, title: string, over: Record<string, any> = {}) => ({
  story_id: id, embedding: null, audience: null, desk, title, summary: "s", why: null,
  url: `https://example.com/${id}`, canon_url: `https://example.com/${id}`, title_key: `t:${desk}|${id}`,
  sources: [], salience: 50, priority: 1, published_at: null, quote: null, editorial_read: null,
  added_at: new Date().toISOString(), ...over,
});
const feed = async (uid: string) => ((await (await SELF.fetch(`${BASE}/api/feed/latest?limit=100`, { headers: { cookie: await cookie(uid) } })).json()) as any).items as any[];
const post = async (uid: string, path: string, body: any) =>
  await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { cookie: await cookie(uid), "content-type": "application/json" }, body: JSON.stringify(body) });

describe("stakesOf", () => {
  it("is max(salience/100, priority floor) and threshold is 0.5", () => {
    expect(stakesOf(55, 2)).toBe(0.55);
    expect(stakesOf(30, 1)).toBe(0.30);
    expect(stakesOf(90, 3)).toBe(1);
    expect(stakesOf(10, 2)).toBe(0.5); // p2 floor
    expect(NEED_THRESHOLD).toBe(0.5);
    expect(NEED_MARK_CAP).toBe(3);
  });
});

describe("Need marking in the feed", () => {
  it("marks a high-stakes in-your-area story, not a low-stakes one", async () => {
    const uid = "apple:need-audience";
    await profile(uid).markOnboarded();
    await ingest([
      story("na-hi", "planning", "Big development approved by your street", { audience: uid, priority: 2, salience: 55 }),
      story("na-lo", "planning", "A small porch nearby", { audience: uid, priority: 1, salience: 30 }),
    ]);
    const items = await feed(uid);
    const hi = items.find((i) => i.id === "na-hi"), lo = items.find((i) => i.id === "na-lo");
    expect(hi.worthKnowing).toBe(true);
    expect(hi.needWhy).toBe("Significant · near your home");
    expect(lo.worthKnowing).toBeUndefined(); // 0.30 < 0.5
  });

  it("a scope tag surfaces + marks a high-stakes story even on an unfollowed desk", async () => {
    const uid = "apple:need-tag";
    await post(uid, "/api/me/scope", { add: "acme" }); // onboards + anchors
    await ingest([
      story("nt-hit", "business", "Acme Corp announces major layoffs", { priority: 2, salience: 70 }),
      story("nt-miss", "business", "Unrelated merger completes", { priority: 2, salience: 70 }),
    ]);
    const items = await feed(uid);
    const hit = items.find((i) => i.id === "nt-hit");
    expect(hit).toBeTruthy(); // surfaced even though "business" is not followed
    expect(hit.worthKnowing).toBe(true);
    expect(hit.needWhy).toMatch(/affects acme/);
    expect(items.some((i) => i.id === "nt-miss")).toBe(false); // no anchor, not followed ⇒ absent
  });

  it("caps at NEED_MARK_CAP: 5 in-scope stories ⇒ exactly 3 marked (the highest need)", async () => {
    const uid = "apple:need-cap";
    await profile(uid).markOnboarded();
    await ingest([90, 80, 70, 60, 55].map((sal, i) =>
      story(`nc-${i}`, "planning", `Local item ${i}`, { audience: uid, priority: 2, salience: sal })));
    const items = await feed(uid);
    const marked = items.filter((i) => i.worthKnowing);
    expect(marked.length).toBe(3);
    expect(new Set(marked.map((i) => i.id))).toEqual(new Set(["nc-0", "nc-1", "nc-2"])); // highest salience
  });

  it("a priority-3 story is never 'Worth knowing' and still tops the feed", async () => {
    const uid = "apple:need-p3";
    await profile(uid).markOnboarded();
    await ingest([
      story("np-urgent", "weather", "Severe flood warning", { audience: uid, priority: 3, salience: 95 }),
      story("np-need", "planning", "Development near you", { audience: uid, priority: 2, salience: 60 }),
    ]);
    const items = await feed(uid);
    expect(items[0].id).toBe("np-urgent");
    expect(items[0].worthKnowing).toBeUndefined();
    expect(items.find((i) => i.id === "np-need").worthKnowing).toBe(true);
  });

  it("degrades to no-op with no scope: nothing marked, want order unchanged", async () => {
    const uid = "apple:need-none";
    await profile(uid).setFollow("world", 1);
    await ingest([
      story("nn-a", "world", "World A", { salience: 80 }),
      story("nn-b", "world", "World B", { salience: 40 }),
      story("nn-u", "weather", "Urgent", { priority: 3, salience: 90 }),
    ]);
    const items = await feed(uid);
    expect(items.every((i) => !i.worthKnowing)).toBe(true);
    expect(items[0].id).toBe("nn-u"); // p3 floats
    const world = items.filter((i) => i.desk === "world").map((i) => i.id);
    expect(world).toEqual(["nn-a", "nn-b"]); // salience order preserved
  });
});

describe("Scope endpoints + Article-9 screen", () => {
  it("rejects Article-9 free-text (the blocker fix) and accepts a place/org", async () => {
    const uid = "apple:scope-art9";
    for (const bad of ["diabetes", "pregnancy", "religion", "gay rights", "my cancer support"]) {
      expect((await post(uid, "/api/me/scope", { add: bad })).status).toBe(422);
    }
    const ok = await post(uid, "/api/me/scope", { add: "Acme Corporation" });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).ok).toBe(true);
  });

  it("adds/removes tags and toggles the nudge, never leaking a vector", async () => {
    const uid = "apple:scope-crud";
    await post(uid, "/api/me/scope", { add: "Worcester" });
    const g = await (await SELF.fetch(`${BASE}/api/me/scope`, { headers: { cookie: await cookie(uid) } })).json() as any;
    expect(g.tags).toEqual([{ tag: "Worcester" }]);
    expect(JSON.stringify(g)).not.toContain("vec");
    expect(Array.isArray(g.catalog)).toBe(true);
    expect(g.nudge).toBe(false); // OFF by default
    expect((await (await post(uid, "/api/me/scope", { nudge: true })).json() as any).nudge).toBe(true);
    const rem = await (await post(uid, "/api/me/scope", { remove: "Worcester" })).json() as any;
    expect(rem.tags).toEqual([]);
  });
});

describe("Gentle-nudge gate (isInterruptible scopeNudge)", () => {
  it("only 'open' + fresh interrupts; focus/meeting/commuting held; rate-limited", async () => {
    const p = profile("apple:nudge-gate");
    await p.reportState("open");
    expect((await p.isInterruptible(2, Date.now(), { scopeNudge: true })).decision).toBe("interrupt");
    await p.reportState("commuting"); // narrower than p3 — commuting does NOT nudge
    expect((await p.isInterruptible(2, Date.now(), { scopeNudge: true })).decision).toBe("digest");
    await p.reportState("focus");
    expect((await p.isInterruptible(2, Date.now(), { scopeNudge: true })).decision).toBe("digest");
    // Rate limit: once nudged, held for 20h regardless of state.
    await p.reportState("open");
    await p.markNudged();
    expect((await p.isInterruptible(2, Date.now(), { scopeNudge: true })).decision).toBe("digest");
  });

  it("without scopeNudge, priority-2 never interrupts (p3 gate unchanged)", async () => {
    const p = profile("apple:nudge-off");
    await p.reportState("open");
    expect((await p.isInterruptible(2, Date.now())).decision).toBe("digest"); // only p3
    expect((await p.isInterruptible(3, Date.now())).decision).toBe("interrupt");
  });
});
