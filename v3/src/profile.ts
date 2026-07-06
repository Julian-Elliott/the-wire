import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { SIGNAL_STRENGTH, decayed } from "./lib/decay";

// ProfileDO ("Persona") — one per user, keyed idFromName(userId)
// (V3_BLUEPRINT §4). Derivation is strictly one-directional:
// signals → traits → policies. The DO owns decay; callers only ever
// propose signals. Coarse device states decay to "unknown" after 30
// minutes, and unknown ALWAYS demotes to digest (§5 trust ladder).

export type CoarseState = "focus" | "meeting" | "commuting" | "workout" | "asleep" | "open";
export type PlaceClass = "home" | "work" | "transit" | "away";

export interface Signal {
  sourceApp: string;
  type: string;
  entity?: string;
  value?: string | number;
}

export interface Trait {
  key: string;
  value: number;
  confidence: number;
  halfLifeDays: number;
  updatedAt: string;
  evidenceCount: number;
}

export interface InterruptVerdict {
  decision: "interrupt" | "digest" | "silent";
  reason: string;
}

const STATE_FRESH_MS = 30 * 60_000; // trust ladder: older than this = unknown
const SIGNAL_RETENTION_DAYS = 90;
const DEFAULT_HALF_LIFE_DAYS = 30;
const SWEEP_INTERVAL_MS = 7 * 86_400_000;

export class ProfileDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS signals (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          ts         TEXT NOT NULL,
          source_app TEXT NOT NULL,
          type       TEXT NOT NULL,
          entity     TEXT,
          value      TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_signals_ts ON signals(ts);

        CREATE TABLE IF NOT EXISTS traits (
          key            TEXT PRIMARY KEY,
          value          REAL NOT NULL,
          confidence     REAL NOT NULL DEFAULT 0,
          half_life_days REAL NOT NULL DEFAULT ${DEFAULT_HALF_LIFE_DAYS},
          updated_at     TEXT NOT NULL,
          evidence_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      // Weekly decay/prune sweep — the decay job owns the traits table.
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
      }
    });
  }

  // Signals are the only write path into traits (signals → traits, never
  // the reverse). Affinity signals fold into desk.weight.<entity> with
  // decay-then-add semantics.
  async recordSignal(sig: Signal, nowMs = Date.now()): Promise<{ accepted: boolean; affectedTraits: string[] }> {
    const ts = new Date(nowMs).toISOString();
    this.ctx.storage.sql.exec(
      "INSERT INTO signals (ts, source_app, type, entity, value) VALUES (?,?,?,?,?)",
      ts, String(sig.sourceApp ?? "unknown").slice(0, 40), String(sig.type ?? "").slice(0, 60),
      sig.entity ? String(sig.entity).slice(0, 80) : null,
      sig.value != null ? String(sig.value).slice(0, 200) : null,
    );

    const affected: string[] = [];
    // Own-property lookup only (review finding): a signal type of
    // "constructor"/"toString" must not resolve to Object.prototype members
    // and poison the traits table with NaN.
    const strength = Object.hasOwn(SIGNAL_STRENGTH, sig.type)
      ? SIGNAL_STRENGTH[sig.type]
      : undefined;
    if (typeof strength === "number" && sig.entity) {
      const key = `desk.weight.${sig.entity}`;
      const row = this.ctx.storage.sql
        .exec<{ value: number; half_life_days: number; updated_at: string; evidence_count: number }>(
          "SELECT value, half_life_days, updated_at, evidence_count FROM traits WHERE key = ?",
          key,
        )
        .toArray()[0];
      const prior = row ? decayed(row.value, Date.parse(row.updated_at), nowMs, row.half_life_days) : 0;
      const next = Math.max(0, prior + strength);
      const evidence = (row?.evidence_count ?? 0) + 1;
      const confidence = Math.min(1, evidence / 20);
      this.ctx.storage.sql.exec(
        `INSERT INTO traits (key, value, confidence, half_life_days, updated_at, evidence_count)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, confidence = excluded.confidence,
           updated_at = excluded.updated_at, evidence_count = excluded.evidence_count`,
        key, next, confidence, row?.half_life_days ?? DEFAULT_HALF_LIFE_DAYS, new Date(nowMs).toISOString(), evidence,
      );
      affected.push(key);
    }
    return { accepted: true, affectedTraits: affected };
  }

  // Reads apply decay on the fly; the stored value is only rewritten by
  // signals and the weekly sweep (no read-amplified writes).
  async getTraits(prefix?: string, nowMs = Date.now()): Promise<Trait[]> {
    const rows = this.ctx.storage.sql
      .exec<{ key: string; value: number; confidence: number; half_life_days: number; updated_at: string; evidence_count: number }>(
        prefix
          ? "SELECT * FROM traits WHERE key LIKE ? ORDER BY key"
          : "SELECT * FROM traits ORDER BY key",
        ...(prefix ? [prefix + "%"] : []),
      )
      .toArray();
    return rows.map((r) => ({
      key: r.key,
      value: decayed(r.value, Date.parse(r.updated_at), nowMs, r.half_life_days),
      confidence: r.confidence,
      halfLifeDays: r.half_life_days,
      updatedAt: r.updated_at,
      evidenceCount: r.evidence_count,
    }));
  }

  // Coarse device state (§2): the ONLY context the server ever stores.
  async reportState(state: CoarseState, place?: PlaceClass, nowMs = Date.now()): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('state', ?), ('state_at', ?), ('place', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(state), String(nowMs), place ? String(place) : "unknown",
    );
  }

  // §5 trust ladder, server-side gate. Deliberately conservative: the
  // failure mode is a story arriving later in a digest, never a ping
  // during a funeral.
  async isInterruptible(priority: 1 | 2 | 3, nowMs = Date.now()): Promise<InterruptVerdict> {
    if (priority < 3) return { decision: "digest", reason: "only priority-3 may interrupt" };

    const meta = new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('state','state_at')")
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    const state = meta.get("state") as CoarseState | undefined;
    const stateAt = Number(meta.get("state_at") ?? 0);

    if (!state || !stateAt || nowMs - stateAt > STATE_FRESH_MS) {
      return { decision: "digest", reason: "state unknown or stale (>30m) — unknown always demotes" };
    }
    if (state === "asleep") return { decision: "silent", reason: "asleep — held for the morning edition" };
    // ALLOW-list (review finding): only explicitly permissive states may
    // interrupt. Any state this code does not recognise — including values
    // added by a future client version — demotes, never interrupts.
    if (state === "open" || state === "commuting") {
      return { decision: "interrupt", reason: `state ${state} is fresh and permissive` };
    }
    return { decision: "digest", reason: `held back — ${state}` };
  }

  // One-off v2 import (V3_BLUEPRINT §11): seeds config (desks, notes,
  // styles, window, show), the user's name (unrecoverable from Apple after
  // first auth), and desk weights as decayable traits. Idempotent: re-runs
  // overwrite config/name and re-seed traits only where evidence is absent
  // (real signals must never be clobbered by a replayed migration).
  async importV2(
    payload: {
      name?: string;
      config?: Record<string, unknown>;
      traits?: { key: string; value: number }[];
    },
    nowMs = Date.now(),
  ): Promise<{ ok: true; traitsSeeded: number }> {
    const nowIso = new Date(nowMs).toISOString();
    const putMeta = (key: string, value: string) =>
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key, value,
      );
    if (payload.name) putMeta("name", String(payload.name).slice(0, 80));
    if (payload.config) putMeta("v2config", JSON.stringify(payload.config).slice(0, 8192));

    let seeded = 0;
    for (const t of payload.traits ?? []) {
      const key = String(t.key ?? "").slice(0, 80);
      const value = Number(t.value);
      if (!key.startsWith("desk.weight.") || !Number.isFinite(value)) continue;
      const res = this.ctx.storage.sql.exec(
        `INSERT INTO traits (key, value, confidence, half_life_days, updated_at, evidence_count)
         VALUES (?, ?, 0.25, 90, ?, 0)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
           WHERE traits.evidence_count = 0`,
        key, Math.max(0, value), nowIso,
      );
      seeded += res.rowsWritten > 0 ? 1 : 0;
    }
    return { ok: true, traitsSeeded: seeded };
  }

  async getConfig(): Promise<{ name: string | null; config: Record<string, unknown> | null }> {
    const meta = new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM meta WHERE key IN ('name','v2config')")
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    let config: Record<string, unknown> | null = null;
    try {
      config = meta.has("v2config") ? JSON.parse(meta.get("v2config")!) : null;
    } catch {
      config = null;
    }
    return { name: meta.get("name") ?? null, config };
  }

  async ping(): Promise<{ ok: true; signals: number; traits: number }> {
    const signals = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM signals").one().n;
    const traits = this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM traits").one().n;
    return { ok: true, signals, traits };
  }

  // Weekly sweep: prune old signals (aggregates survive in traits) and
  // rewrite decayed trait values so storage reflects reality.
  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const cutoff = new Date(nowMs - SIGNAL_RETENTION_DAYS * 86_400_000).toISOString();
    this.ctx.storage.sql.exec("DELETE FROM signals WHERE ts < ?", cutoff);
    const rows = this.ctx.storage.sql
      .exec<{ key: string; value: number; half_life_days: number; updated_at: string }>(
        "SELECT key, value, half_life_days, updated_at FROM traits",
      )
      .toArray();
    for (const r of rows) {
      const v = decayed(r.value, Date.parse(r.updated_at), nowMs, r.half_life_days);
      if (v < 0.01) this.ctx.storage.sql.exec("DELETE FROM traits WHERE key = ?", r.key);
      else {
        this.ctx.storage.sql.exec(
          "UPDATE traits SET value = ?, updated_at = ? WHERE key = ?",
          v, new Date(nowMs).toISOString(), r.key,
        );
      }
    }
    await this.ctx.storage.setAlarm(nowMs + SWEEP_INTERVAL_MS);
  }
}
