import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import { ENGAGEMENT_EVENTS, SERVER_OWNED_EVENTS, dayOf } from "../src/lib/engage";

const BASE = "https://wire.databased.business";
const SECRET = "test-session-secret";

const cookie = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken(SECRET, {
    uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  }));

const post = (body: unknown) =>
  SELF.fetch(`${BASE}/api/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const db = () => (env as unknown as { DB: D1Database }).DB;

const countOf = async (event: string, product = "v3") => {
  const row = await db().prepare(
    "SELECT count FROM engagement_daily WHERE day = ?1 AND event = ?2 AND product = ?3",
  ).bind(dayOf(), event, product).first<{ count: number }>();
  return row?.count ?? 0;
};

describe("POST /api/event", () => {
  it("rejects unknown events", async () => {
    const res = await post({ event: "totally_made_up" });
    expect(res.status).toBe(400);
  });

  it("rejects invalid JSON", async () => {
    const res = await post("{nope");
    expect(res.status).toBe(400);
  });

  it("rejects oversized payloads", async () => {
    const res = await post({ event: "edition_opened", pad: "x".repeat(8 * 1024) });
    expect(res.status).toBe(413);
  });

  it("refuses server-owned events from clients (no double counting)", async () => {
    for (const event of SERVER_OWNED_EVENTS) {
      const res = await post({ event });
      expect(res.status).toBe(400);
    }
  });

  it("increments the daily rollup, anonymously, and is idempotent per call", async () => {
    const before = await countOf("edition_opened");
    expect((await post({ event: "edition_opened" })).status).toBe(200);
    expect((await post({ event: "edition_opened" })).status).toBe(200);
    expect(await countOf("edition_opened")).toBe(before + 2);
  });

  it("buckets an explicit v2 product separately (the living-lab column)", async () => {
    const before = await countOf("linkout_opened", "v2");
    expect((await post({ event: "linkout_opened", product: "v2" })).status).toBe(200);
    expect(await countOf("linkout_opened", "v2")).toBe(before + 1);
    // Unknown products fall back to v3 rather than growing the enum.
    const v3Before = await countOf("linkout_opened", "v3");
    expect((await post({ event: "linkout_opened", product: "vx" })).status).toBe(200);
    expect(await countOf("linkout_opened", "v3")).toBe(v3Before + 1);
  });
});

describe("read-ledger derived events", () => {
  it("bumps story_read when /api/read records state=read", async () => {
    const before = await countOf("story_read");
    const res = await SELF.fetch(`${BASE}/api/read`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookie("u-engage-1") },
      body: JSON.stringify({
        url: "https://example.com/engage-1", desk: "markets", title: "A story", state: "read",
      }),
    });
    expect(res.status).toBe(200);
    expect(await countOf("story_read")).toBe(before + 1);
  });

  it("does not bump counters for seen/delivered states", async () => {
    const before = await countOf("story_read");
    const res = await SELF.fetch(`${BASE}/api/read`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: await cookie("u-engage-2") },
      body: JSON.stringify({
        url: "https://example.com/engage-2", desk: "markets", title: "Seen only", state: "seen",
      }),
    });
    expect(res.status).toBe(200);
    expect(await countOf("story_read")).toBe(before);
  });
});

describe("GET /api/dev/scorecard", () => {
  it("401s anonymously", async () => {
    const res = await SELF.fetch(`${BASE}/api/dev/scorecard`);
    expect(res.status).toBe(401);
  });

  it("returns rollup rows and the event vocabulary when signed in", async () => {
    await post({ event: "edition_opened" });
    const res = await SELF.fetch(`${BASE}/api/dev/scorecard`, {
      headers: { cookie: await cookie("u-engage-3") },
    });
    expect(res.status).toBe(200);
    const data = await res.json() as {
      ok: boolean;
      events: string[];
      days: { day: string; event: string; product: string; count: number }[];
    };
    expect(data.ok).toBe(true);
    expect(data.events).toEqual([...ENGAGEMENT_EVENTS]);
    const today = data.days.filter((r) => r.day === dayOf());
    expect(today.some((r) => r.event === "edition_opened" && r.count >= 1)).toBe(true);
  });
});
