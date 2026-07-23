import { describe, expect, it } from "vitest";
import {
  queryTokens, searchId, lexicalScore, scoreAgainstQuery, normalizeQuery,
  SEARCH_COS_MIN, SAVED_COS_MIN,
} from "../src/lib/search";

// Pure unit tests (no worker, no AI). The semantic path is exercised with
// synthetic vectors so both the cosine blend and the AI-absent degrade are proven.

const vec = (arr: number[]) => Float32Array.from(arr);

describe("queryTokens", () => {
  it("keeps len>=2 tokens so EV/AI/F1/UK survive", () => {
    expect(queryTokens("EV AI F1")).toEqual(["ev", "ai", "f1"]);
  });
  it("drops stopwords and dedups", () => {
    expect(queryTokens("the latest Tesla news")).toEqual(["tesla"]);
    expect(queryTokens("tesla Tesla TESLA")).toEqual(["tesla"]);
  });
});

describe("searchId", () => {
  it("collapses case/punctuation to one id, distinguishes real differences", () => {
    expect(searchId("Tesla")).toBe(searchId("tesla!"));
    expect(searchId("  TESLA  ")).toBe(searchId("tesla"));
    expect(searchId("tesla")).not.toBe(searchId("toyota"));
  });
});

describe("lexicalScore (whole-token, no substring false positives)", () => {
  it("does NOT match a token inside a longer word", () => {
    expect(lexicalScore(["art"], "the race to start", "art")).toBe(0);
    expect(lexicalScore(["ai"], "he said nothing", "ai")).toBe(0);
    expect(lexicalScore(["ev"], "every voter agreed", "ev")).toBe(0); // len<4 ⇒ no prefix rescue
  });
  it("prefix-rescues inflections for len>=4 tokens", () => {
    expect(lexicalScore(["flood"], "flooding in yorkshire", "flood")).toBeGreaterThan(0);
    expect(lexicalScore(["tesla"], "teslas recalled again", "tesla")).toBeGreaterThan(0);
  });
  it("floors an exact multi-word phrase at 0.9, but never a single word substring", () => {
    expect(lexicalScore(["interest", "rates"], "the bank raised interest rates", "interest rates")).toBeGreaterThanOrEqual(0.9);
    expect(lexicalScore(["start"], "the race to start", "start")).toBeGreaterThan(0); // whole token, legitimately
    expect(lexicalScore(["art"], "start of the year", "art")).toBe(0); // single word: no phrase floor
  });
});

describe("scoreAgainstQuery", () => {
  it("semantic hit when the query and story vectors align", () => {
    const q = vec([1, 0, 0]);
    const parallel = vec([0.9, 0.1, 0]); // cosine ~0.994
    const r = scoreAgainstQuery(q, ["zzz"], "zzz", parallel, "unrelated words", SEARCH_COS_MIN);
    expect(r.semantic).toBeGreaterThan(SEARCH_COS_MIN);
    expect(r.hit).toBe(true);
  });
  it("no hit when orthogonal and no lexical overlap", () => {
    const r = scoreAgainstQuery(vec([1, 0, 0]), ["cricket"], "cricket", vec([0, 1, 0]), "banking merger news", SEARCH_COS_MIN);
    expect(r.hit).toBe(false);
  });
  it("dual threshold: admitted by the instant floor, rejected by the stricter saved floor", () => {
    // Build vectors with cosine ≈ 0.46 (between 0.42 and 0.50), no lexical overlap.
    const q = vec([1, 0]);
    const s = vec([0.46, Math.sqrt(1 - 0.46 * 0.46)]); // cosine == 0.46
    expect(scoreAgainstQuery(q, ["zzz"], "zzz", s, "no overlap", SEARCH_COS_MIN).hit).toBe(true);
    expect(scoreAgainstQuery(q, ["zzz"], "zzz", s, "no overlap", SAVED_COS_MIN).hit).toBe(false);
  });
  it("AI-absent (null query vec) ⇒ pure lexical, never errors", () => {
    const r = scoreAgainstQuery(null, ["flood"], "flood", null, normalizeQuery("Flooding closes the line"), SEARCH_COS_MIN);
    expect(r.semantic).toBe(0);
    expect(r.score).toBe(r.lexical);
    expect(r.hit).toBe(true);
  });
});
