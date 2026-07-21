import { describe, expect, it } from "vitest";
import {
  affinityOf, rankStories, recencyFactor, salienceFactor, scoreStory, whyRanked,
  type RankContext, type RankableStory,
} from "../src/lib/rank";

const H = 3_600_000;
const story = (over: Partial<RankableStory> = {}): RankableStory => ({
  id: "s", desk: "world", salience: 50, addedAtMs: 0, vec: null, ...over,
});

const flatCtx = (over: Partial<RankContext> = {}): RankContext => ({
  nowMs: 0,
  deskWeight: () => 1,
  deskCentroid: () => null,
  corpusMean: null,
  ...over,
});

describe("component factors", () => {
  it("salience floor 0.5 → 1.5", () => {
    expect(salienceFactor(0)).toBe(0.5);
    expect(salienceFactor(100)).toBe(1.5);
    expect(salienceFactor(50)).toBe(1.0);
  });
  it("recency halves at ~18h", () => {
    expect(recencyFactor(0)).toBe(1);
    expect(recencyFactor(18 * H)).toBeCloseTo(0.5, 5);
    expect(recencyFactor(36 * H)).toBeCloseTo(0.25, 5);
  });
  it("affinity is neutral (1.0) with no centroid/vector", () => {
    expect(affinityOf(story(), flatCtx()).factor).toBe(1);
  });
});

describe("scoreStory", () => {
  it("multiplies weight × salience × recency × affinity", () => {
    const s = scoreStory(story({ salience: 100, addedAtMs: 0 }), flatCtx({ nowMs: 0, deskWeight: () => 2 }));
    expect(s.score).toBeCloseTo(2 * 1.5 * 1 * 1, 5);
    expect(s.components.deskWeight).toBe(2);
  });

  it("a followed desk outranks an unfollowed one at equal salience/recency", () => {
    const ctx = flatCtx({ deskWeight: (d) => (d === "liverpool" ? 3 : 1) });
    const a = scoreStory(story({ desk: "liverpool" }), ctx).score;
    const b = scoreStory(story({ desk: "gaming" }), ctx).score;
    expect(a).toBeGreaterThan(b);
  });

  it("taste vector tilts ranking toward similar stories (positive-only)", () => {
    // Centroid points +y after centring; a matching story gets an affinity > 1.
    const corpusMean = Float32Array.from([3, 0, 0]);
    const ctx = flatCtx({
      corpusMean,
      deskCentroid: () => Float32Array.from([0, 1, 0]), // already centred
    });
    const match = affinityOf(story({ vec: Float32Array.from([3, 1, 0]) }), ctx);
    const against = affinityOf(story({ vec: Float32Array.from([3, -1, 0]) }), ctx);
    expect(match.factor).toBeGreaterThan(1);
    expect(against.factor).toBe(1); // negative cosine never punishes (max(0,·))
  });
});

describe("rankStories ordering", () => {
  it("sorts best-first and is stable on a realistic mix", () => {
    const ctx = flatCtx({ nowMs: 40 * H, deskWeight: (d) => (d === "markets" ? 2 : 1) });
    const items = [
      story({ id: "old-lowdesk", desk: "gaming", salience: 40, addedAtMs: 0 }),
      story({ id: "fresh-highdesk", desk: "markets", salience: 80, addedAtMs: 39 * H }),
      story({ id: "fresh-lowdesk", desk: "gaming", salience: 50, addedAtMs: 39 * H }),
    ];
    const ranked = rankStories(items, ctx);
    expect(ranked[0].story.id).toBe("fresh-highdesk");
    expect(ranked[ranked.length - 1].story.id).toBe("old-lowdesk");
  });
});

describe("whyRanked transparency", () => {
  it("names the followed desk and taste match", () => {
    const why = whyRanked(
      { deskWeight: 2, salience: 1.3, recency: 0.9, affinity: 1.3, cosine: 0.3 },
      "liverpool",
    );
    expect(why).toContain("liverpool");
    expect(why.toLowerCase()).toContain("read");
  });
  it("falls back to a plain desk line when nothing stands out", () => {
    expect(whyRanked({ deskWeight: 0.5, salience: 0.6, recency: 0.2, affinity: 1, cosine: null }, "ev"))
      .toBe("on your ev desk");
  });
});
