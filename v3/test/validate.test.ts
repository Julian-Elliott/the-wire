import { describe, expect, it } from "vitest";
import {
  checkLiveness, independentHosts, quoteAppears, validateBatch, type Fetcher, type IngestItem,
} from "../src/lib/validate";

const item = (over: Partial<IngestItem> = {}): IngestItem => ({
  category: "world",
  title: "A test story headline with enough tokens",
  summary: "Summary.",
  url: "https://example.com/story",
  ...over,
});

const fetcherReturning = (status: number, body = ""): Fetcher =>
  async () => new Response(body || null, { status });

describe("URL liveness", () => {
  it("2xx is alive; 404/410/5xx and network errors are dead", async () => {
    expect((await checkLiveness("https://x", false, fetcherReturning(200))).alive).toBe(true);
    expect((await checkLiveness("https://x", false, fetcherReturning(404))).alive).toBe(false);
    expect((await checkLiveness("https://x", false, fetcherReturning(410))).alive).toBe(false);
    expect((await checkLiveness("https://x", false, fetcherReturning(503))).alive).toBe(false);
    const boom: Fetcher = async () => { throw new Error("net"); };
    expect((await checkLiveness("https://x", false, boom)).alive).toBe(false);
  });

  it("paywalls and refusals (401/402/403) count as ALIVE — an answer, not an error", async () => {
    for (const s of [401, 402, 403]) {
      expect((await checkLiveness("https://x", false, fetcherReturning(s))).alive).toBe(true);
    }
  });
});

describe("verbatim quote verification", () => {
  const page = `<html><body><p>The minister said: “We will not raise fuel duty
      this parliament,” before leaving.</p></body></html>`;
  it("matches across whitespace, tags and curly quotes", () => {
    expect(quoteAppears('We will not raise fuel duty this parliament', page)).toBe(true);
    expect(quoteAppears('"We will not raise fuel duty this parliament,"', page)).toBe(true);
  });
  it("rejects a quote that is not on the page", () => {
    expect(quoteAppears("We will raise fuel duty next year", page)).toBe(false);
  });
  it("a batch item with a bad quote is rejected with the reason", async () => {
    const f = fetcherReturning(200, page);
    const res = await validateBatch([item({ quote: "Entirely fabricated words" })], f);
    expect(res.ok).toHaveLength(0);
    expect(res.rejected[0]?.reason).toBe("quote-not-found");
  });
  it("a quote behind a 403 paywall is STRIPPED, never checked against the challenge page", async () => {
    const challenge = "<html><body>Access denied. Complete the security check.</body></html>";
    const res = await validateBatch(
      [item({ quote: "We will not raise fuel duty this parliament" })],
      fetcherReturning(403, challenge),
    );
    expect(res.rejected).toHaveLength(0); // 403 is alive; the interstitial proves nothing
    expect(res.ok).toHaveLength(1);
    expect(res.ok[0]?.quote).toBeUndefined(); // unverifiable words do not survive
    expect(res.unverified[0]?.reason).toBe("quote-unverifiable:403");
  });
  it("a bodyless alive response also strips the quote instead of silently trusting it", async () => {
    const res = await validateBatch(
      [item({ quote: "A fabricated quote nobody can check" })],
      fetcherReturning(304),
    );
    expect(res.ok).toHaveLength(1);
    expect(res.ok[0]?.quote).toBeUndefined();
    expect(res.unverified[0]?.reason).toBe("quote-unverifiable:304");
  });
});

describe("two-source rule for priority 3", () => {
  it("counts independent canonical hosts", () => {
    expect(independentHosts(item({ sources: ["https://www.example.com/mirror"] }))).toHaveLength(1);
    expect(independentHosts(item({ sources: ["https://other.org/report"] }))).toHaveLength(2);
  });
  it("demotes single-source priority-3 to priority 2 (never rejects, never interrupts)", async () => {
    const res = await validateBatch([item({ priority: 3 })], fetcherReturning(200), { skipNetwork: true });
    expect(res.demoted).toHaveLength(1);
    expect(res.demoted[0]?.reason).toBe("two-source-rule");
    expect(res.ok[0]?.priority).toBe(2);
  });
  it("keeps priority 3 when two independent hosts are pinned", async () => {
    const res = await validateBatch(
      [item({ priority: 3, sources: ["https://other.org/second-report"] })],
      fetcherReturning(200),
      { skipNetwork: true },
    );
    expect(res.demoted).toHaveLength(0);
    expect(res.ok[0]?.priority).toBe(3);
  });

  it("network path: a FABRICATED second source demotes — the second host must answer", async () => {
    const f: Fetcher = async (url) =>
      new Response(null, { status: url.includes("other.org") ? 404 : 200 });
    const res = await validateBatch(
      [item({ priority: 3, sources: ["https://other.org/made-up-path"] })],
      f,
    );
    expect(res.demoted).toHaveLength(1);
    expect(res.demoted[0]?.reason).toBe("second-source-dead");
    expect(res.ok[0]?.priority).toBe(2);
  });

  it("network path: a live second source keeps priority 3", async () => {
    const res = await validateBatch(
      [item({ priority: 3, sources: ["https://other.org/real-report"] })],
      fetcherReturning(200),
    );
    expect(res.demoted).toHaveLength(0);
    expect(res.ok[0]?.priority).toBe(3);
  });
});

describe("batch liveness", () => {
  it("dead URLs are rejected with their status; alive pass through", async () => {
    const f: Fetcher = async (url) =>
      new Response(null, { status: url.includes("dead") ? 404 : 200 });
    const res = await validateBatch(
      [item({ url: "https://example.com/ok" }), item({ url: "https://example.com/dead", title: "Another different headline entirely here" })],
      f,
    );
    expect(res.ok).toHaveLength(1);
    expect(res.rejected[0]?.reason).toBe("url-dead:404");
  });
});
