import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signToken } from "../src/lib/auth";

// Calm scorecard (Wave A #7): the new events are accepted, and /api/dev/scorecard
// derives the inverted calm metrics (relevance / completion / calm sentiment).

const BASE = "https://wire.databased.business";
const cookie = async (uid: string) =>
  "sess=" + encodeURIComponent(await signToken("test-session-secret", { uid, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }));

const fire = (event: string) =>
  SELF.fetch(`${BASE}/api/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event }) });

describe("Calm scorecard", () => {
  it("accepts the new calm events and rejects unknown ones", async () => {
    for (const ev of ["first_relevant_story", "survey_calmer", "survey_same", "survey_noisier", "edition_finished"]) {
      expect((await fire(ev)).status).toBe(200);
    }
    expect((await fire("doomscroll_started")).status).toBe(400); // not in the vocabulary
  });

  it("derives inverted calm metrics from the window", async () => {
    // Seed a small, known distribution.
    await Promise.all([
      fire("edition_opened"), fire("edition_opened"), fire("edition_opened"), fire("edition_opened"),
      fire("first_relevant_story"), fire("first_relevant_story"), fire("first_relevant_story"),
      fire("edition_finished"), fire("edition_finished"),
      fire("survey_calmer"), fire("survey_calmer"), fire("survey_calmer"), fire("survey_noisier"),
    ]);
    const res = await SELF.fetch(`${BASE}/api/dev/scorecard`, { headers: { cookie: await cookie("apple:scorecard") } });
    const b = (await res.json()) as Record<string, any>;
    expect(b.ok).toBe(true);
    expect(b.calm).toBeTruthy();
    // engagement_daily accumulates across the run, so assert shape + bounds, not
    // exact values: relevance/completion are >0 ratios; calm sentiment is sane.
    expect(typeof b.calm.relevanceRate).toBe("number");
    expect(b.calm.relevanceRate).toBeGreaterThan(0);
    expect(typeof b.calm.completionRate).toBe("number");
    expect(b.calm.completionRate).toBeGreaterThan(0);
    expect(b.calm.calmSentiment.calmer).toBeGreaterThanOrEqual(3);
    expect(b.calm.calmSentiment.responses).toBeGreaterThanOrEqual(4);
    expect(b.calm.calmSentiment.calmRatio).toBeGreaterThan(0);
    expect(b.calm.calmSentiment.calmRatio).toBeLessThanOrEqual(1);
  });

  it("requires a session for the scorecard", async () => {
    expect((await SELF.fetch(`${BASE}/api/dev/scorecard`)).status).toBe(401);
  });
});
