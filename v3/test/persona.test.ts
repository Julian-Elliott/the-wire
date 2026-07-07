import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SIGNAL_STRENGTH, decayFactor, decayed } from "../src/lib/decay";
import type { InterruptVerdict, Trait } from "../src/profile";

// Typed handle on a ProfileDO stub (RPC methods).
interface PersonaStub {
  recordSignal(sig: { sourceApp: string; type: string; entity?: string }, nowMs?: number): Promise<{ accepted: boolean; affectedTraits: string[] }>;
  getTraits(prefix?: string, nowMs?: number): Promise<Trait[]>;
  reportState(state: string, place?: string, nowMs?: number): Promise<void>;
  isInterruptible(priority: 1 | 2 | 3, nowMs?: number): Promise<InterruptVerdict>;
  ping(): Promise<{ ok: true; signals: number; traits: number }>;
}

const persona = (name: string): PersonaStub => {
  const ns = (env as Record<string, any>).PROFILES;
  return ns.get(ns.idFromName(name)) as PersonaStub;
};

describe("decay maths (pure)", () => {
  it("halves at exactly one half-life", () => {
    expect(decayFactor(30 * 86_400_000, 30)).toBeCloseTo(0.5, 10);
    expect(decayed(2.0, 0, 30 * 86_400_000, 30)).toBeCloseTo(1.0, 10);
  });
  it("dismissals are weaker than reads and negative", () => {
    expect(SIGNAL_STRENGTH["story.dismissed"]).toBeLessThan(0);
    expect(Math.abs(SIGNAL_STRENGTH["story.dismissed"])).toBeLessThan(SIGNAL_STRENGTH["story.read"]);
  });
});

describe("signals → traits", () => {
  it("prototype-key signal types never resolve to Object.prototype members", async () => {
    const p = persona("u-proto");
    const t0 = Date.parse("2026-07-01T00:00:00Z");
    for (const type of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const res = await p.recordSignal({ sourceApp: "wire", type, entity: "liverpool" }, t0);
      expect(res.affectedTraits).toHaveLength(0);
    }
    expect(await p.getTraits("desk.weight.", t0)).toHaveLength(0);
  });

  it("reads accumulate a desk affinity with decay-then-add", async () => {
    const p = persona("u1");
    const t0 = Date.parse("2026-07-01T00:00:00Z");
    await p.recordSignal({ sourceApp: "wire", type: "story.read", entity: "liverpool" }, t0);
    await p.recordSignal({ sourceApp: "wire", type: "story.read", entity: "liverpool" }, t0 + 3_600_000);
    const traits = await p.getTraits("desk.weight.", t0 + 3_600_000);
    expect(traits).toHaveLength(1);
    expect(traits[0].key).toBe("desk.weight.liverpool");
    // Two reads an hour apart ≈ 1.0 (tiny decay on the first)
    expect(traits[0].value).toBeGreaterThan(0.99);
    expect(traits[0].value).toBeLessThanOrEqual(1.0);
    expect(traits[0].evidenceCount).toBe(2);
  });

  it("a burst of dismissals dents but does not erase an affinity", async () => {
    const p = persona("u2");
    const t0 = Date.parse("2026-07-01T00:00:00Z");
    for (let i = 0; i < 6; i++) {
      await p.recordSignal({ sourceApp: "wire", type: "story.read", entity: "gaming" }, t0 + i * 60_000);
    }
    for (let i = 0; i < 3; i++) {
      await p.recordSignal({ sourceApp: "wire", type: "story.dismissed", entity: "gaming" }, t0 + (10 + i) * 60_000);
    }
    const [t] = await p.getTraits("desk.weight.gaming", t0 + 20 * 60_000);
    expect(t.value).toBeGreaterThan(1.5); // 6×0.5 − 3×0.3 ≈ 2.1, minus negligible decay
  });

  it("reads apply decay without rewriting storage", async () => {
    const p = persona("u3");
    const t0 = Date.parse("2026-07-01T00:00:00Z");
    await p.recordSignal({ sourceApp: "wire", type: "story.starred", entity: "ev" }, t0);
    const [fresh] = await p.getTraits("desk.weight.ev", t0);
    const [later] = await p.getTraits("desk.weight.ev", t0 + 30 * 86_400_000);
    expect(fresh.value).toBeCloseTo(1.0, 5);
    expect(later.value).toBeCloseTo(0.5, 5); // one half-life later
  });
});

describe("§5 trust ladder (server-side gate)", () => {
  const now = Date.parse("2026-07-06T09:00:00Z");

  it("only priority 3 may interrupt", async () => {
    const p = persona("u4");
    await p.reportState("open", "home", now);
    expect((await p.isInterruptible(2, now)).decision).toBe("digest");
    expect((await p.isInterruptible(3, now)).decision).toBe("interrupt");
  });

  it("unknown state always demotes to digest", async () => {
    const p = persona("u5-neverreported");
    const v = await p.isInterruptible(3, now);
    expect(v.decision).toBe("digest");
    expect(v.reason).toContain("unknown");
  });

  it("state older than 30 minutes decays to unknown", async () => {
    const p = persona("u6");
    await p.reportState("open", "home", now);
    expect((await p.isInterruptible(3, now + 29 * 60_000)).decision).toBe("interrupt");
    expect((await p.isInterruptible(3, now + 31 * 60_000)).decision).toBe("digest");
  });

  it("meetings hold back; sleep goes silent; commutes interrupt", async () => {
    const p = persona("u7");
    await p.reportState("meeting", "work", now);
    expect((await p.isInterruptible(3, now)).decision).toBe("digest");
    await p.reportState("asleep", "home", now);
    expect((await p.isInterruptible(3, now)).decision).toBe("silent");
    await p.reportState("commuting", "transit", now);
    expect((await p.isInterruptible(3, now)).decision).toBe("interrupt");
  });
});
