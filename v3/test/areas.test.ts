import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { signToken } from "../src/lib/auth";
import type { Trigger } from "../src/lib/signals/types";
import { routeInterrupts } from "../src/signals";

// Per-user planning areas (V3_BLUEPRINT §7) + audience-scoped stories:
// "planning app 250 m from home" means THEIR home — the trigger must reach
// only its user, and their local story must never leak into anyone else's
// feed (it would reveal the approximate home area, §8).

const e = env as Record<string, any>;
const BASE = "https://wire.databased.business";

const profile = (uid: string) => e.PROFILES.get(e.PROFILES.idFromName(uid)) as any;

const sessionCookie = async (uid: string) =>
  "sess=" +
  encodeURIComponent(
    await signToken("test-session-secret", { uid, exp: Math.floor(Date.now() / 1000) + 3600 }),
  );

const storyRow = (id: string, audience: string | null) => ({
  story_id: id,
  embedding: null,
  audience,
  desk: "planning",
  title: `Planning application ${id}`,
  summary: "A new porch.",
  why: "near home",
  url: `https://www.planit.org.uk/${id}`,
  canon_url: `https://www.planit.org.uk/${id}`,
  title_key: `t:planning|${id}`,
  sources: ["planit"],
  salience: 55,
  priority: 2,
  published_at: null,
  quote: null,
  editorial_read: null,
  added_at: new Date().toISOString(),
});

describe("ProfileDO home area", () => {
  it("rounds to 3 dp on write and round-trips", async () => {
    const p = profile("apple:area-roundtrip");
    const set = await p.setHomeArea(52.1923456, -2.2214567);
    expect(set).toEqual({ lat: 52.192, lon: -2.221 });
    expect(await p.getHomeArea()).toEqual({ lat: 52.192, lon: -2.221 });
  });

  it("clears with nulls", async () => {
    const p = profile("apple:area-clear");
    await p.setHomeArea(51.5, -0.1);
    await p.setHomeArea(null, null);
    expect(await p.getHomeArea()).toBeNull();
  });
});

describe("/api/me/area", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/me/area`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/me/area`, { method: "POST", body: "{}" })).status).toBe(401);
  });

  it("rejects garbage coordinates", async () => {
    const cookie = await sessionCookie("apple:area-api");
    const res = await SELF.fetch(`${BASE}/api/me/area`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ lat: 999, lon: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("sets, reads back rounded, and clears", async () => {
    const cookie = await sessionCookie("apple:area-api");
    const set = await SELF.fetch(`${BASE}/api/me/area`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ lat: 52.1919999, lon: -2.2205001 }),
    });
    expect(((await set.json()) as any).area).toEqual({ lat: 52.192, lon: -2.221 });

    const got = await SELF.fetch(`${BASE}/api/me/area`, { headers: { cookie } });
    expect(((await got.json()) as any).area).toEqual({ lat: 52.192, lon: -2.221 });

    const clr = await SELF.fetch(`${BASE}/api/me/area`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ lat: null, lon: null }),
    });
    expect(((await clr.json()) as any).area).toBeNull();
  });
});

describe("audience-scoped stories in the feed", () => {
  it("anonymous feed hides scoped stories; the owner sees theirs, nobody else's", async () => {
    const ns = e.NEWSROOM.get(e.NEWSROOM.idFromName("main")) as any;
    await ns.ingestBatch([
      storyRow("aud-global", null),
      storyRow("aud-mine", "apple:area-owner"),
      storyRow("aud-theirs", "apple:area-other"),
    ]);

    const anonIds = (((await (await SELF.fetch(`${BASE}/api/feed/latest?limit=200`)).json()) as any).items as any[])
      .map((i) => i.id);
    expect(anonIds).toContain("aud-global");
    expect(anonIds).not.toContain("aud-mine");
    expect(anonIds).not.toContain("aud-theirs");

    const cookie = await sessionCookie("apple:area-owner");
    const mineIds = (((await (await SELF.fetch(`${BASE}/api/feed/latest?limit=200`, { headers: { cookie } })).json()) as any).items as any[])
      .map((i) => i.id);
    expect(mineIds).toContain("aud-global");
    expect(mineIds).toContain("aud-mine");
    expect(mineIds).not.toContain("aud-theirs");
  });

  it("identically-titled scoped stories are NOT cross-user deduped", async () => {
    const ns = e.NEWSROOM.get(e.NEWSROOM.idFromName("main")) as any;
    const a = { ...storyRow("aud-dup-a", "apple:dup-a"), title: "Planning application near you" };
    const b = { ...storyRow("aud-dup-b", "apple:dup-b"), title: "Planning application near you" };
    const res = await ns.ingestBatch([a, b]);
    expect(res.inserted).toBe(2);
    expect(res.clusterDups).toBe(0);
  });
});

describe("audience-targeted interrupts", () => {
  it("routes an audience trigger through ONLY that user's gate", async () => {
    await e.DB.prepare("DELETE FROM demotion_ledger").run();
    await e.DB.prepare("DELETE FROM users").run();
    for (const uid of ["apple:aud-target", "apple:aud-bystander"]) {
      await e.DB.prepare("INSERT OR IGNORE INTO users (uid, created_at) VALUES (?1, ?2)")
        .bind(uid, new Date().toISOString()).run();
    }
    const t: Trigger = {
      source: "planit",
      desk: "planning",
      dedupKey: "apple:aud-target:planning:xyz",
      title: "Demolition next door",
      summary: "They're knocking it down.",
      why: "planning trigger near your home",
      url: "https://www.planit.org.uk",
      priority: 3,
      expiresHours: 24,
      audience: "apple:aud-target",
    };
    const ctx = createExecutionContext();
    const out = await routeInterrupts(e as any, ctx, [t], vi.fn(async () => {}));
    await waitOnExecutionContext(ctx);

    // Neither user has fresh state -> the target demotes; the bystander is
    // never evaluated at all.
    expect(out).toEqual({ pushed: 0, heldToDigest: 1 });
    const rows = (
      await e.DB.prepare("SELECT user_id FROM demotion_ledger").all()
    ).results as { user_id: string }[];
    expect(rows.map((r) => r.user_id)).toEqual(["apple:aud-target"]);
  });
});
