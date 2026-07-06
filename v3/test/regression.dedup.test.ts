// Regression suite, part 1: the audited v2 dedup bugs (V3_BLUEPRINT §12
// Phase 1: "the first test suite is v2's audited silent-failure list").
import { describe, expect, it } from "vitest";
import {
  dedupeBatch, isStale, matchKeys, titleKey, urlKey,
} from "../src/lib/dedup";
import { TITLE_KEY_MAX, nearDupTitle, normTitle } from "../src/lib/text";
import { canonUrl } from "../src/lib/urls";

describe("v2 bug: title clamp mismatch (240 at ingest vs 160 in seen record)", () => {
  it("a long title produces the SAME key whether stored clamped or unclamped", () => {
    const long = "Breaking " + "very important development ".repeat(12); // > 240 chars
    const storedAt160 = long.slice(0, 160);
    const storedAt240 = long.slice(0, 240);
    expect(normTitle(long)).toBe(normTitle(storedAt160));
    expect(titleKey({ category: "world", title: long })).toBe(
      titleKey({ category: "world", title: storedAt240 }),
    );
  });

  it("clamp constant is what the keys actually use", () => {
    const t = "x".repeat(TITLE_KEY_MAX) + "DIFFERENT-TAIL";
    expect(normTitle(t)).toBe(normTitle(t.slice(0, TITLE_KEY_MAX)));
  });
});

describe("v2 bug: same-day dedup used raw URLs while cross-day used canonical", () => {
  it("utm-variant links collapse within one batch", () => {
    const a = { category: "world", title: "Summit ends in agreement", url: "https://www.example.com/story?utm_source=x" };
    const b = { category: "world", title: "Talks conclude with deal signed", url: "http://example.com/story/" };
    expect(canonUrl(a.url)).toBe(canonUrl(b.url));
    const { kept, dropped } = dedupeBatch([a, b]);
    expect(kept).toHaveLength(1);
    expect(dropped[0]?.reason).toBe("duplicate-in-batch");
  });

  it("urlKey and matchKeys agree on the canonical form", () => {
    const it1 = { category: "world", title: "T", url: "HTTPS://WWW.Example.com/a?fbclid=1#frag" };
    expect(urlKey(it1)).toBe("u:" + canonUrl(it1.url));
    expect(matchKeys(it1)).toContain(urlKey(it1));
  });
});

describe("near-duplicate titles (Jaccard >= 0.6, min 3 tokens)", () => {
  it("catches the same development reworded", () => {
    expect(nearDupTitle(
      "Liverpool agree record fee for striker signing",
      "Liverpool agree record striker fee",
    )).toBe(true);
  });
  it("short recurring titles never match (markets-style)", () => {
    expect(nearDupTitle("FTSE 100", "FTSE 100")).toBe(false);
  });
  it("dedupeBatch drops rewords within a desk but not across desks", () => {
    const batch = [
      { category: "world", title: "Government announces sweeping energy reforms today" },
      { category: "world", title: "Sweeping energy reforms announces government today" },
      { category: "ev", title: "Government announces sweeping energy reforms today" },
    ];
    const { kept, dropped } = dedupeBatch(batch);
    expect(kept).toHaveLength(2);
    expect(dropped[0]?.reason).toBe("near-duplicate-title");
  });
  it("markets desk is exempt from title matching but not URL matching", () => {
    const batch = [
      { category: "markets", title: "FTSE 100 closes higher on bank earnings today", url: "https://a.com/1" },
      { category: "markets", title: "FTSE 100 closes higher on earnings from banks today", url: "https://b.com/2" },
    ];
    expect(dedupeBatch(batch).kept).toHaveLength(2);
  });
});

describe("cross-day seen keys", () => {
  it("drops a story served yesterday under a tracking-param variant URL", () => {
    const served = { category: "world", title: "Landmark ruling on data privacy handed down", url: "https://example.com/ruling" };
    const priorKeys = new Set(matchKeys(served));
    const today = { ...served, url: "https://www.example.com/ruling?utm_campaign=daily" };
    const { kept, dropped } = dedupeBatch([today], priorKeys);
    expect(kept).toHaveLength(0);
    expect(dropped[0]?.reason).toBe("seen-before");
  });
});

describe("recency gate: drop ONLY confidently-dated stale stories", () => {
  const now = Math.floor(Date.UTC(2026, 6, 6) / 1000);
  it("drops a March story surfacing in July (dated URL)", () => {
    expect(isStale({ category: "world", title: "t", url: "https://ex.com/2026/03/12/old-story" }, now)).toBe(true);
  });
  it("never drops an undateable story", () => {
    expect(isStale({ category: "world", title: "t", url: "https://ex.com/evergreen-story" }, now)).toBe(false);
  });
  it("never drops a recent story", () => {
    expect(isStale({ category: "world", title: "t", publishedAt: "2026-07-05T10:00:00Z" }, now)).toBe(false);
  });
  it("respects the per-desk max-age (worcester 21d vs liverpool 7d)", () => {
    const tenDaysAgo = new Date((now - 10 * 86400) * 1000).toISOString();
    expect(isStale({ category: "liverpool", title: "t", publishedAt: tenDaysAgo }, now)).toBe(true);
    expect(isStale({ category: "worcester", title: "t", publishedAt: tenDaysAgo }, now)).toBe(false);
  });
});
