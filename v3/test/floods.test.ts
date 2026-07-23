import { describe, expect, it } from "vitest";
import { pollFloods } from "../src/lib/signals/floods";

// Environment Agency flood warnings (local-by-civic, Wave B). No live network in
// tests — a fake fetcher returns a synthetic EA response so the severity→trust-
// ladder mapping is proven deterministically.
const eaFetch = (items: any[]): any =>
  async () => new Response(JSON.stringify({ items }), { status: 200 });
const flood = (severityLevel: number, over: Record<string, any> = {}) => ({
  "@id": `https://environment.data.gov.uk/flood-monitoring/id/floods/${severityLevel}`,
  description: "River Severn from Bewdley to Worcester", severity: null, severityLevel,
  message: "River levels are rising.", floodAreaID: `FA${severityLevel}`,
  floodArea: { riverOrSea: "River Severn", county: "Worcestershire" }, ...over,
});

describe("pollFloods", () => {
  it("maps severity onto the trust ladder: severe→p3, warning→p2, alert→p1; drops 'no longer in force'", async () => {
    const res = await pollFloods({ lat: 52.19, lon: -2.22 }, eaFetch([
      flood(1, { severity: "Severe Flood Warning" }),
      flood(2, { severity: "Flood Warning" }),
      flood(3, { severity: "Flood Alert" }),
      flood(4, { severity: "Warning no longer in force" }), // dropped
    ]));
    expect(res.backend).toBe("environment-agency");
    const byPriority = res.triggers.map((t) => t.priority).sort();
    expect(byPriority).toEqual([1, 2, 3]); // exactly three; level-4 dropped
    const severe = res.triggers.find((t) => t.priority === 3)!;
    expect(severe.desk).toBe("weather");
    expect(severe.source).toBe("environment-agency");
    expect(severe.title).toMatch(/Severe Flood Warning: River Severn/);
    expect(severe.why).toMatch(/danger to life/);
    expect(severe.url).toBe("https://check-for-flooding.service.gov.uk");
  });

  it("dedup key content-addresses the flood area, and it survives a missing severity label", async () => {
    const res = await pollFloods({ lat: 0, lon: 0 }, eaFetch([flood(2, { severity: null })]));
    expect(res.triggers[0].dedupKey).toBe("flood:FA2");
    expect(res.triggers[0].title).toMatch(/^Flood warning:/); // synthesised label fallback
  });

  it("returns no triggers on an empty area and never throws on a bad body", async () => {
    expect((await pollFloods({ lat: 0, lon: 0 }, eaFetch([]))).triggers).toEqual([]);
    const bad: any = async () => new Response("{}", { status: 200 });
    expect((await pollFloods({ lat: 0, lon: 0 }, bad)).triggers).toEqual([]); // no items key
  });

  it("throws on a non-ok response (so the poller is marked failed, never a bad edition)", async () => {
    const fail: any = async () => new Response("", { status: 503 });
    await expect(pollFloods({ lat: 0, lon: 0 }, fail)).rejects.toThrow(/floods 503/);
  });
});
