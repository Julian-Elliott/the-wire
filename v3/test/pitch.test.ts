import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";
import { clampPitch, cleanPitches, pickSummary } from "../src/lib/pitch";
import type { StoredStory } from "../src/newsroom";

describe("pitch selection (pure)", () => {
  const story = { summary: "the normal brief", pitches: { explain: "in plain words", insider: "just the numbers" } };
  it("picks the level, falling back to summary", () => {
    expect(pickSummary(story, 0)).toBe("in plain words");
    expect(pickSummary(story, 1)).toBe("the normal brief");
    expect(pickSummary(story, 2)).toBe("just the numbers");
    expect(pickSummary({ summary: "only this" }, 0)).toBe("only this"); // no pitches → fallback
    expect(pickSummary({ summary: "only this", pitches: { insider: "x" } }, 0)).toBe("only this"); // missing level → fallback
  });
  it("clamps to 0/1/2", () => {
    expect(clampPitch(0)).toBe(0);
    expect(clampPitch(2)).toBe(2);
    expect(clampPitch(5)).toBe(1);
    expect(clampPitch("nonsense")).toBe(1);
  });
  it("cleanPitches accepts named or numeric keys and bounds text", () => {
    const c = (s: string) => s.trim();
    expect(cleanPitches({ explain: "a", insider: "b" }, c, 100)).toEqual({ explain: "a", insider: "b" });
    expect(cleanPitches({ "0": "x", "2": "y" }, c, 100)).toEqual({ explain: "x", insider: "y" });
    expect(cleanPitches({}, c, 100)).toBeNull();
    expect(cleanPitches("nope", c, 100)).toBeNull();
  });
});

describe("ingest stores pitches; feed serves the user's per-desk level", () => {
  const session = async (uid: string) =>
    "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

  it("round-trips a pitched story and the feed picks Insider for a set desk", async () => {
    const ns = (env as Record<string, any>).NEWSROOM;
    const nr = ns.get(ns.idFromName("main")) as any;
    const s: StoredStory = {
      story_id: "pitch-1", embedding: null, desk: "liverpool",
      title: "Reds sign a striker", summary: "Liverpool have signed a new striker for a club-record fee.",
      why: null, url: "https://example.com/pitch-1", canon_url: "https://example.com/pitch-1",
      title_key: "t:liverpool|pitch-1", sources: [], salience: 60, priority: 1,
      published_at: null, quote: null, editorial_read: null, added_at: new Date().toISOString(),
      pitches: { explain: "Liverpool bought a new goal-scorer. It cost a lot of money.", insider: "Done deal, club-record fee, medical passed. He's ours." },
    };
    await nr.ingestBatch([s]);
    // Stored + returned intact.
    const feedRows = await nr.feed(50);
    expect(feedRows.find((r: any) => r.story_id === "pitch-1")?.pitches?.insider).toContain("Done deal");

    const uid = "apple:pitch-reader";
    const ck = await session(uid);
    const p = (env as Record<string, any>).PROFILES;
    const stub = p.get(p.idFromName(uid)) as any;
    await stub.setFollow("liverpool", 3);
    await stub.setPitch("liverpool", 2); // Insider

    const res = await SELF.fetch("https://wire.databased.business/api/feed/latest?limit=50", { headers: { cookie: ck } });
    const b = (await res.json()) as Record<string, any>;
    const item = b.items.find((i: any) => i.id === "pitch-1");
    expect(item.summary).toContain("Done deal"); // served at Insider level
    expect(item.pitch).toBe(2);
  });

  it("defaults to the normal summary when no pitch level is set", async () => {
    const uid = "apple:pitch-default";
    const ck = await session(uid);
    const p = (env as Record<string, any>).PROFILES;
    await (p.get(p.idFromName(uid)) as any).setFollow("liverpool", 1);
    const res = await SELF.fetch("https://wire.databased.business/api/feed/latest?limit=50", { headers: { cookie: ck } });
    const item = ((await res.json()) as any).items.find((i: any) => i.id === "pitch-1");
    expect(item.summary).toContain("club-record fee."); // the plain summary
    expect(item.pitch).toBe(1);
  });
});
