import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /api/health", () => {
  it("returns the full contract shape with green store checks", async () => {
    const res = await SELF.fetch("https://wire.databased.business/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.checks).toEqual({ kv: "ok", d1: "ok", r2: "ok", newsroom: "ok" });
    // Contract keys exist even when features haven't landed (null, not absent).
    for (const key of [
      "version",
      "last_ingest",
      "newest_story_age_h",
      "crons",
      "audio_spend_mtd_gbp",
      "audio_cap_pct",
    ]) {
      expect(body).toHaveProperty(key);
    }
  });
});

describe("GET /", () => {
  it("identifies the service", async () => {
    const res = await SELF.fetch("https://wire.databased.business/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe("wire-api");
  });
});

describe("unknown routes", () => {
  it("404s as JSON", async () => {
    const res = await SELF.fetch("https://wire.databased.business/nope");
    expect(res.status).toBe(404);
  });
});
