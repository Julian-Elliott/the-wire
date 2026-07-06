// Regression suite, part 2: the audited v2 gate + lock bugs.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkDailyCap, checkThrottle, recordSuccess, type KVLike } from "../src/lib/gate";
import { acquireLock, releaseLock } from "../src/lib/lock";

// In-memory KVLike with TTL support driven by a fake clock.
function fakeKV(clock: { now: number }): KVLike {
  const raw = new Map<string, { v: string; exp?: number }>();
  return {
    async get(k) {
      const e = raw.get(k);
      if (!e) return null;
      if (e.exp !== undefined && clock.now >= e.exp) { raw.delete(k); return null; }
      return e.v;
    },
    async put(k, v, opts) {
      raw.set(k, { v, exp: opts?.expirationTtl ? clock.now + opts.expirationTtl : undefined });
    },
    async delete(k) { raw.delete(k); },
  };
}

const db = (): D1Database => (env as Record<string, any>).DB as D1Database;

describe("v2 bug: daily cap counted attempts, starving later crons", () => {
  it("failures never consume quota (success-only counting)", async () => {
    const clock = { now: 1000 };
    const kv = fakeKV(clock);
    // Simulate 5 failed attempts: check passes each time, recordSuccess never called.
    for (let i = 0; i < 5; i++) {
      expect((await checkDailyCap(kv, "fire", "2026-07-06", 3)).allowed).toBe(true);
    }
    // Then 3 successes hit the cap; the 4th is refused.
    for (let i = 0; i < 3; i++) {
      expect((await checkDailyCap(kv, "fire", "2026-07-06", 3)).allowed).toBe(true);
      await recordSuccess(kv, "fire", "2026-07-06", clock.now);
    }
    expect((await checkDailyCap(kv, "fire", "2026-07-06", 3)).allowed).toBe(false);
    // A new day starts clean.
    expect((await checkDailyCap(kv, "fire", "2026-07-07", 3)).allowed).toBe(true);
  });
});

describe("v2 bug: the poll gate wedged shut after a lost generation", () => {
  it("throttle stamps expire — a crashed run delays, never blocks forever", async () => {
    const clock = { now: 1000 };
    const kv = fakeKV(clock);
    await recordSuccess(kv, "refresh", "2026-07-06", clock.now, { throttleTtlSec: 900 });
    expect((await checkThrottle(kv, "refresh", 900, clock.now + 60)).allowed).toBe(false);
    clock.now += 901; // TTL passed — the gate MUST reopen on its own
    expect((await checkThrottle(kv, "refresh", 900, clock.now)).allowed).toBe(true);
  });

  it("throttle reports retry-after so callers can surface it honestly", async () => {
    const clock = { now: 5000 };
    const kv = fakeKV(clock);
    await recordSuccess(kv, "refresh", "2026-07-06", clock.now, { throttleTtlSec: 900 });
    const res = await checkThrottle(kv, "refresh", 900, clock.now + 300);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBe(600);
  });
});

describe("v2 bug: lock released by a request that never held it (D1-backed)", () => {
  it("release without acquisition is a no-op (the double-billing bug)", async () => {
    const now = 1_000_000;
    const tokenA = await acquireLock(db(), "render:ep1", 300, now);
    expect(tokenA).toBeTruthy();
    // B fails to acquire, then (v2 finally-block style) tries to release anyway.
    const tokenB = await acquireLock(db(), "render:ep1", 300, now + 1);
    expect(tokenB).toBeNull();
    expect(await releaseLock(db(), "render:ep1", tokenB)).toBe(false);
    // A still holds the lock; only A's token releases it.
    expect(await acquireLock(db(), "render:ep1", 300, now + 2)).toBeNull();
    expect(await releaseLock(db(), "render:ep1", tokenA)).toBe(true);
    expect(await acquireLock(db(), "render:ep1", 300, now + 3)).toBeTruthy();
  });

  it("a crashed holder's lock expires via TTL", async () => {
    const now = 2_000_000;
    expect(await acquireLock(db(), "render:ep2", 300, now)).toBeTruthy();
    expect(await acquireLock(db(), "render:ep2", 300, now + 301)).toBeTruthy();
  });

  it("concurrent acquisition admits exactly one caller (atomic INSERT)", async () => {
    const now = 3_000_000;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => acquireLock(db(), "render:ep3", 300, now)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
