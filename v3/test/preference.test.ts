import { describe, expect, it } from "vitest";
import { analyseDesk, auc, buildCentroid, centre, meanVector } from "../src/lib/preference";

const v = (...n: number[]) => Float32Array.from(n);

describe("preference maths", () => {
  it("meanVector averages component-wise", () => {
    expect([...meanVector([v(1, 0), v(3, 2)])!]).toEqual([2, 1]);
    expect(meanVector([])).toBeNull();
  });

  it("centre subtracts the corpus mean (anisotropy fix)", () => {
    // Two vectors sharing a big common direction: after centring they oppose.
    const mean = v(3, 0);
    expect([...centre(v(3, 0.5), mean)]).toEqual([0, 0.5]);
    expect([...centre(v(3, -0.5), mean)]).toEqual([0, -0.5]);
  });

  it("buildCentroid is positive-only and mean-centred", () => {
    const mean = v(3, 0);
    const c = buildCentroid([v(3, 1), v(3, -1)], mean)!;
    expect([...c]).toEqual([0, 0]); // the two residuals cancel
  });

  it("AUC is 1.0 when liked all outscore skipped, 0.5 at chance, null if one side empty", () => {
    expect(auc([0.9, 0.8], [0.2, 0.1])).toBe(1);
    expect(auc([0.5], [0.5])).toBe(0.5); // tie
    expect(auc([0.3, 0.7], [0.5])).toBeCloseTo(0.5, 5);
    expect(auc([], [0.1])).toBeNull();
  });
});

describe("analyseDesk", () => {
  const corpusMean = v(3, 0, 0);
  it("a learned desk separates liked above skipped (AUC > 0.5)", () => {
    // Liked stories point +y after centring; skipped point -y.
    const liked = [v(3, 1, 0), v(3, 0.9, 0.1)];
    const current = [
      { id: "a", title: "matches taste", vec: v(3, 1, 0), behaviour: "liked" as const },
      { id: "b", title: "against taste", vec: v(3, -1, 0), behaviour: "skipped" as const },
    ];
    const r = analyseDesk("world", liked, corpusMean, current, 0.8);
    expect(r.auc).toBe(1);
    expect(r.stories[0].id).toBe("a"); // sorted best-first
    expect(r.passportWeight).toBe(0.8);
  });

  it("flags a cold desk (too few positives) and gives null AUC with no labels", () => {
    const r = analyseDesk("ev", [v(3, 1, 0)], corpusMean, [
      { id: "x", title: "unseen story", vec: v(3, 0.5, 0), behaviour: "unseen" as const },
    ], null);
    expect(r.status).toBe("cold");
    expect(r.positives).toBe(1);
    expect(r.auc).toBeNull(); // no liked+skipped pair among current
  });

  it("no positives → cosine 0, honest empty centroid", () => {
    const r = analyseDesk("gaming", [], corpusMean, [
      { id: "y", title: "a story", vec: v(3, 1, 0), behaviour: "unseen" as const },
    ], null);
    expect(r.stories[0].cosine).toBe(0);
    expect(r.status).toBe("cold");
  });
});
