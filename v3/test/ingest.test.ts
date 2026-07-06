// NOTE: vitest-pool-workers v4 shares DO storage across tests in a run, so
// every test uses its own unique stories and asserts on presence, not totals.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://wire.databased.business";

const post = (body: unknown, secret = "test-secret") =>
  SELF.fetch(`${BASE}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

const feedItems = async (): Promise<Record<string, any>[]> => {
  const res = await SELF.fetch(`${BASE}/api/feed/latest?limit=200`);
  return ((await res.json()) as Record<string, any>).items;
};

// Undated URLs + a live publishedAt so the recency gate never rots these
// fixtures as the real clock advances (review finding).
let seq = 0;
const mk = (desk: string, over: Record<string, unknown> = {}) => {
  const n = ++seq;
  return {
    category: desk,
    // Mostly-distinct tokens per title: within-batch near-dup matching
    // (Jaccard >= .6) must not collapse unrelated fixtures.
    title: `${desk} bulletin item${n}a item${n}b item${n}c item${n}d item${n}e`,
    summary: "A summary of the development.",
    url: `https://example.com/${desk}/story-${n}`,
    salience: 50,
    publishedAt: new Date().toISOString(),
    ...over,
  };
};

describe("POST /api/ingest", () => {
  it("rejects a bad secret", async () => {
    expect((await post({ items: [mk("world")] }, "wrong")).status).toBe(401);
  });

  it("accepts the v2 routine's x-ingest-key header style", async () => {
    const res = await SELF.fetch(`${BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-key": "test-secret" },
      body: JSON.stringify({ items: [mk("world")] }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects an empty payload", async () => {
    expect((await post({ items: [] })).status).toBe(400);
  });

  it("accepts a batch, is idempotent on replay, and serves the feed", async () => {
    const a = mk("world");
    const b = mk("liverpool");
    const first = await post({ items: [a, b], editorialRead: "sober morning brief" });
    expect(first.status).toBe(200);
    const b1 = (await first.json()) as Record<string, any>;
    expect(b1.accepted).toBe(2);
    expect(b1.inserted).toBe(2);

    // Replay: the same stories must be dropped as seen, not re-inserted.
    const second = await post({ items: [a, b] });
    const b2 = (await second.json()) as Record<string, any>;
    expect(b2.inserted).toBe(0);
    expect(b2.dropped.seen).toBe(2);

    const items = await feedItems();
    const got = items.find((i) => i.title === a.title);
    expect(got).toBeTruthy();
    expect(got).toHaveProperty("desk", "world");
    expect(got).toHaveProperty("addedAt");

    // Health now reports a fresh feed age.
    const health = await SELF.fetch(`${BASE}/api/health`);
    const hb = (await health.json()) as Record<string, any>;
    expect(hb.ok).toBe(true);
    expect(hb.newest_story_age_h).not.toBeNull();
    expect(hb.newest_story_age_h).toBeLessThan(1);
    expect(hb.last_ingest).not.toBeNull();
  });

  it("drops malformed and confidently-stale items, counting each", async () => {
    const good = mk("world");
    const staleDate = new Date(Date.now() - 90 * 86_400_000).toISOString(); // 90d > every desk max-age
    const res = await post({
      items: [
        { category: "world", title: "No URL so malformed" },
        mk("world", { publishedAt: staleDate }),
        good,
      ],
    });
    const b = (await res.json()) as Record<string, any>;
    expect(b.dropped.malformed).toBe(1);
    expect(b.dropped.stale).toBe(1);
    expect(b.accepted).toBe(1);
  });

  it("rejects private/loopback URLs as malformed (SSRF guard)", async () => {
    const res = await post({
      items: [
        mk("world", { url: "http://localhost/admin" }),
        mk("world", { url: "http://192.168.1.1/router" }),
        mk("world", { url: "http://metadata.internal/latest" }),
        mk("world"),
      ],
    });
    const b = (await res.json()) as Record<string, any>;
    expect(b.dropped.malformed).toBe(3);
    expect(b.accepted).toBe(1);
  });

  it("counts batch overflow past the cap instead of silently discarding", async () => {
    // Distinct hosts so the per-outlet cap stays out of this test's way.
    const many = Array.from({ length: 65 }, (_, i) =>
      mk("world", { url: `https://site-${i}.example.com/story-${i}` }),
    );
    const res = await post({ items: many });
    const b = (await res.json()) as Record<string, any>;
    expect(b.dropped.overflow).toBe(5);
    expect(b.accepted).toBe(60);
  });

  it("caps any single outlet inside a batch", async () => {
    const many = Array.from({ length: 10 }, () => mk("world", undefined));
    const res = await post({ items: many }); // all on example.com
    const b = (await res.json()) as Record<string, any>;
    expect(b.accepted).toBe(6);
    expect(b.dropped.outletCap).toBe(4);
  });

  it("demotes single-source priority-3 to digest tier", async () => {
    const p3 = mk("world", { priority: 3 });
    const res = await post({ items: [p3] });
    const b = (await res.json()) as Record<string, any>;
    expect(b.demoted).toBe(1);
    const stored = (await feedItems()).find((i) => i.title === p3.title);
    expect(stored?.priority).toBe(2);
  });

  it("keeps priority 3 with two independent sources", async () => {
    const p3 = mk("world", { priority: 3, sources: ["https://other.org/second-report"] });
    const res = await post({ items: [p3] });
    const b = (await res.json()) as Record<string, any>;
    expect(b.demoted).toBe(0);
    const stored = (await feedItems()).find((i) => i.title === p3.title);
    expect(stored?.priority).toBe(3);
  });

  it("collapses utm-variant duplicates inside one batch", async () => {
    const a = mk("world");
    const res = await post({
      items: [
        a,
        { ...a, title: "Different headline for the same link entirely", url: a.url + "?utm_source=news" },
      ],
    });
    const b = (await res.json()) as Record<string, any>;
    expect(b.accepted).toBe(1);
    expect(b.dropped.duplicate).toBe(1);
  });
});
