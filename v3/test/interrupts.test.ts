import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../src/lib/auth";
import type { Trigger } from "../src/lib/signals/types";
import { routeInterrupts } from "../src/signals";

// The interrupt tier's critical path (V3_BLUEPRINT §5, Phase 2 acceptance):
// a priority-3 that fails the gate must appear later WITH its "why demoted"
// note — so every demotion is persisted, and a later delivery clears it.

const e = env as Record<string, any>;
const BASE = "https://wire.databased.business";

const p3 = (over: Partial<Trigger> = {}): Trigger => ({
  source: "weatherkit",
  desk: "weather",
  dedupKey: "weather:frost:2026-07-07",
  title: "Frost warning tonight",
  summary: "Down to -2°C by 06:00 — cover the windscreen.",
  why: "frost trigger, WeatherKit, your area",
  url: "https://wire.databased.business",
  priority: 3,
  expiresHours: 6,
  ...over,
});

async function storyIdOf(dedupKey: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(dedupKey));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seedUser(uid: string) {
  await e.DB.prepare("INSERT OR IGNORE INTO users (uid, created_at) VALUES (?1, ?2)")
    .bind(uid, new Date().toISOString()).run();
}

const profile = (uid: string) => e.PROFILES.get(e.PROFILES.idFromName(uid)) as any;

const demotionsOf = async (uid: string) =>
  (
    await e.DB.prepare("SELECT story_id, decision, reason FROM demotion_ledger WHERE user_id = ?1")
      .bind(uid).all()
  ).results as { story_id: string; decision: string; reason: string }[];

// Storage persists across tests in this file, and routeInterrupts fans out
// over EVERY user row — reset both tables so each test's totals are its own.
beforeEach(async () => {
  await e.DB.prepare("DELETE FROM demotion_ledger").run();
  await e.DB.prepare("DELETE FROM users").run();
});

describe("routeInterrupts — the demotion ledger", () => {
  it("stale/unknown state demotes, and the demotion is written down", async () => {
    const uid = "apple:demote-stale";
    await seedUser(uid); // no state ever reported -> trust ladder says unknown
    const push = vi.fn(async () => {});
    const ctx = createExecutionContext();

    const out = await routeInterrupts(e as any, ctx, [p3()], push);
    await waitOnExecutionContext(ctx);

    expect(out).toEqual({ pushed: 0, heldToDigest: 1 });
    expect(push).not.toHaveBeenCalled();
    const rows = await demotionsOf(uid);
    expect(rows).toHaveLength(1);
    expect(rows[0].story_id).toBe(await storyIdOf(p3().dedupKey));
    expect(rows[0].decision).toBe("digest");
    expect(rows[0].reason).toMatch(/unknown|stale/);
  });

  it("fresh permissive state interrupts and clears a prior demotion row", async () => {
    const uid = "apple:demote-clear";
    await seedUser(uid);
    await profile(uid).reportState("open", "home");
    const storyId = await storyIdOf(p3().dedupKey);
    await e.DB.prepare(
      "INSERT INTO demotion_ledger (user_id, story_id, decision, reason, at) VALUES (?1, ?2, 'digest', 'earlier hold', ?3)",
    ).bind(uid, storyId, new Date().toISOString()).run();

    const push = vi.fn(async () => {});
    const ctx = createExecutionContext();
    const out = await routeInterrupts(e as any, ctx, [p3()], push);
    await waitOnExecutionContext(ctx);

    expect(out).toEqual({ pushed: 1, heldToDigest: 0 });
    expect(push).toHaveBeenCalledTimes(1);
    expect(await demotionsOf(uid)).toHaveLength(0); // delivered -> note cleared
  });

  it("production path: a subscribed user is interrupted, an unsubscribed one is demoted actionably", async () => {
    const subbed = "apple:has-sub";
    const bare = "apple:no-sub";
    await seedUser(subbed);
    await seedUser(bare);
    await profile(subbed).reportState("open", "home");
    await profile(bare).reportState("open", "home");
    // Only `subbed` has a Web Push subscription.
    await e.DB.prepare(
      "INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?1, 'https://push.example/s', 'k', 'a', ?2)",
    ).bind(subbed, new Date().toISOString()).run();

    const ctx = createExecutionContext();
    // No injected push -> the production channel is the subscription itself.
    const out = await routeInterrupts(e as any, ctx, [p3()], undefined);
    await waitOnExecutionContext(ctx);

    expect(out.pushed).toBe(1); // the subscribed user
    expect(out.heldToDigest).toBe(1); // the bare user
    expect((await demotionsOf(bare))[0].reason).toMatch(/turn on .* alerts/);
    expect(await demotionsOf(subbed)).toHaveLength(0); // interrupted, no demotion
  });

  it("asleep is recorded as a silent hold", async () => {
    const uid = "apple:demote-asleep";
    await seedUser(uid);
    await profile(uid).reportState("asleep");
    const ctx = createExecutionContext();

    const out = await routeInterrupts(e as any, ctx, [p3()], vi.fn(async () => {}));
    await waitOnExecutionContext(ctx);

    expect(out.heldToDigest).toBe(1);
    const rows = await demotionsOf(uid);
    expect(rows[0].decision).toBe("silent");
    expect(rows[0].reason).toMatch(/asleep/);
  });

  it("no push channel at all demotes visibly, never silently no-ops", async () => {
    const uid = "apple:demote-nochannel";
    await seedUser(uid);
    await profile(uid).reportState("open", "home"); // gate would say interrupt
    const ctx = createExecutionContext();

    // No push fn and NTFY_TOPIC unset in the test env -> channel unavailable.
    const out = await routeInterrupts(e as any, ctx, [p3()], undefined);
    await waitOnExecutionContext(ctx);

    expect(out).toEqual({ pushed: 0, heldToDigest: 1 });
    const rows = await demotionsOf(uid);
    expect(rows).toHaveLength(1);
    // A subscription-less user is demoted with an ACTIONABLE reason, never a
    // silent no-op (the persona-critique delivery fix).
    expect(rows[0].reason).toMatch(/turn on .* alerts/);
  });

  it("synthetic test triggers are routed but never persisted to the ledger", async () => {
    const uid = "apple:demote-testtrig";
    await seedUser(uid);
    const ctx = createExecutionContext();

    const out = await routeInterrupts(
      e as any, ctx,
      [p3({ source: "test", dedupKey: "test:synthetic" })],
      vi.fn(async () => {}),
    );
    await waitOnExecutionContext(ctx);

    expect(out.heldToDigest).toBe(1); // still counted in the run report
    expect(await demotionsOf(uid)).toHaveLength(0); // no feed row to join
  });

  it("first reason wins on repeated polls of a persisting trigger", async () => {
    const uid = "apple:demote-firstwins";
    await seedUser(uid);
    const ctx = createExecutionContext();
    await routeInterrupts(e as any, ctx, [p3()], vi.fn(async () => {})); // unknown state
    await profile(uid).reportState("meeting", "work");
    await routeInterrupts(e as any, ctx, [p3()], vi.fn(async () => {})); // now "meeting"
    await waitOnExecutionContext(ctx);

    const rows = await demotionsOf(uid);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toMatch(/unknown|stale/); // the note from when it landed
  });
});

describe("GET /api/me/demotions", () => {
  it("requires a session", async () => {
    expect((await SELF.fetch(`${BASE}/api/me/demotions`)).status).toBe(401);
  });

  it("returns the signed-in user's notes", async () => {
    const uid = "apple:demote-api";
    await seedUser(uid);
    const ctx = createExecutionContext();
    await routeInterrupts(e as any, ctx, [p3()], vi.fn(async () => {}));
    await waitOnExecutionContext(ctx);

    const cookie =
      "sess=" +
      encodeURIComponent(
        await signToken("test-session-secret", { uid, exp: Math.floor(Date.now() / 1000) + 3600 }),
      );
    const res = await SELF.fetch(`${BASE}/api/me/demotions`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { demotions: { story_id: string; reason: string }[] };
    expect(body.demotions).toHaveLength(1);
    expect(body.demotions[0].story_id).toBe(await storyIdOf(p3().dedupKey));
    expect(body.demotions[0].reason).toMatch(/unknown|stale/);
  });
});
