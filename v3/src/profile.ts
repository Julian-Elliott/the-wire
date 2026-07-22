import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { SIGNAL_STRENGTH, decayed } from "./lib/decay";
import { gzip } from "./lib/gz";

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

        -- Per-user audit ring buffer (V3_BLUEPRINT §4/§8): every client read
        -- is inspectable ("The Wire read topic.football 14x this week").
        CREATE TABLE IF NOT EXISTS audit (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     TEXT NOT NULL,
          client TEXT NOT NULL,
          tool   TEXT NOT NULL
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
  // GDPR erasure (V3_BLUEPRINT §4 "erasure is a single-object operation"):
  // wipe every table this DO owns. Idempotent. The caller also clears the
  // app-side ledgers (read/demotion) and the users registry row.
  async purge(): Promise<{ ok: true; cleared: string[] }> {
    const cleared: string[] = [];
    for (const t of ["signals", "traits", "meta", "audit"] as const) {
      this.ctx.storage.sql.exec(`DELETE FROM ${t}`);
      cleared.push(t);
    }
    await this.ctx.storage.deleteAlarm();
    return { ok: true, cleared };
  }

  async reportState(state: CoarseState, place?: PlaceClass, nowMs = Date.now()): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('state', ?), ('state_at', ?), ('place', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(state), String(nowMs), place ? String(place) : "unknown",
    );
  }

  // Home area (V3_BLUEPRINT §7 per-user planning). The only coordinates the
  // server ever holds are config the user explicitly supplied (§8 allows
  // exactly that), rounded to 3 dp (~110 m) — enough for a PlanIt radius
  // query, no more. Null clears.
  async setHomeArea(
    lat: number | null,
    lon: number | null,
  ): Promise<{ lat: number; lon: number } | null> {
    if (lat == null || lon == null) {
      this.ctx.storage.sql.exec("DELETE FROM meta WHERE key IN ('home_lat','home_lon')");
      return null;
    }
    const rl = Math.round(Number(lat) * 1000) / 1000;
    const rn = Math.round(Number(lon) * 1000) / 1000;
    if (!Number.isFinite(rl) || !Number.isFinite(rn) || Math.abs(rl) > 90 || Math.abs(rn) > 180) {
      throw new Error("invalid area");
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('home_lat', ?), ('home_lon', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(rl), String(rn),
    );
    return { lat: rl, lon: rn };
  }

  async getHomeArea(): Promise<{ lat: number; lon: number } | null> {
    const meta = new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM meta WHERE key IN ('home_lat','home_lon')",
        )
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    if (!meta.has("home_lat") || !meta.has("home_lon")) return null;
    const lat = Number(meta.get("home_lat"));
    const lon = Number(meta.get("home_lon"));
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
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
    if (payload.config) {
      // Store the whole config JSON — a blind character slice truncates
      // mid-JSON and getConfig's parse then silently loses it (review fix).
      // Skip an implausibly large config rather than corrupt it; the import
      // door already bounds the request body.
      const cfg = JSON.stringify(payload.config);
      if (cfg.length <= 200_000) putMeta("v2config", cfg);
    }

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

  // ---- Explicit follows (the reader's follow-picker) ------------------------
  // A user's chosen desks + weights, stored as meta['follows'] JSON
  // { desk: weight 1..3 }. Distinct from the DECAYED behavioural desk.weight
  // traits: follows are durable user INTENT and never decay. Seeded once from
  // the migrated v2 enabled-desks so an existing user's choices carry over.
  private readFollows(): Record<string, number> | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'follows'")
      .toArray()[0];
    if (!row) return null;
    try {
      const f = JSON.parse(row.value);
      return f && typeof f === "object" ? f : {};
    } catch {
      return {};
    }
  }

  private writeFollows(f: Record<string, number>): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('follows', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(f),
    );
  }

  async getFollows(): Promise<Record<string, number>> {
    const existing = this.readFollows();
    if (existing) return existing;
    // Lazy seed from the migrated v2 config's enabled desks (weight 1 each).
    const cfg = (await this.getConfig()).config as
      | { desks?: { enabled?: unknown } }
      | null;
    const enabled = Array.isArray(cfg?.desks?.enabled) ? (cfg!.desks!.enabled as unknown[]) : [];
    const seeded: Record<string, number> = {};
    for (const d of enabled) {
      const key = String(d).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (key) seeded[key] = 1;
    }
    this.writeFollows(seeded);
    return seeded;
  }

  // weight 0 (or absent) = unfollow/remove; 1..3 = follow strength.
  async setFollow(desk: string, weight: number): Promise<Record<string, number>> {
    const key = String(desk).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const f = await this.getFollows();
    if (!key) return f;
    if (weight <= 0) delete f[key];
    else f[key] = Math.min(3, Math.max(1, Math.round(weight)));
    this.writeFollows(f);
    return f;
  }

  // ---- Catch-up watermark (the edition that ends) --------------------------
  // The moment the user last finished their Catch-up edition; the next edition
  // shows only stories newer than this.
  async getCatchupAt(): Promise<string | null> {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'catchup_at'")
      .toArray()[0];
    return row?.value ?? null;
  }

  async setCatchupAt(iso: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('catchup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      String(iso).slice(0, 40),
    );
  }

  // ---- Pitch level per desk (0 Explain / 1 Normal / 2 Insider) -------------
  // How each desk's stories are written FOR this user. Default (absent) = 1.
  async getPitches(): Promise<Record<string, number>> {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'pitches'")
      .toArray()[0];
    if (!row) return {};
    try {
      const p = JSON.parse(row.value);
      return p && typeof p === "object" ? p : {};
    } catch {
      return {};
    }
  }

  async setPitch(desk: string, level: number): Promise<Record<string, number>> {
    const key = String(desk).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    const p = await this.getPitches();
    if (!key) return p;
    const lvl = level === 0 ? 0 : level === 2 ? 2 : 1;
    if (lvl === 1) delete p[key]; // 1 is the default — store only deviations
    else p[key] = lvl;
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (key, value) VALUES ('pitches', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(p),
    );
    return p;
  }

  // Nightly NDJSON sweep (RUNBOOK §4): DO-SQLite has no platform export, so
  // the DO serialises its own tables to the backups bucket. One line per
  // row: {"table": ..., "row": {...}}.
  async exportToR2(uid: string, dateIso: string): Promise<{ key: string; rows: number }> {
    const lines: string[] = [];
    for (const table of ["meta", "traits", "signals"] as const) {
      for (const row of this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()) {
        lines.push(JSON.stringify({ table, row }));
      }
    }
    const safeUid = uid.replace(/[^A-Za-z0-9._:-]/g, "_");
    const key = `do/ProfileDO/${safeUid}/${dateIso}.ndjson.gz`;
    await this.env.BACKUPS.put(key, await gzip(lines.join("\n")));
    return { key, rows: lines.length };
  }

  // Restore-drill counterpart (RUNBOOK §4): loads an NDJSON dump into THIS
  // instance. Only ever called against scratch/staging DO names.
  async importNdjson(text: string): Promise<{ meta: number; traits: number; signals: number }> {
    const counts = { meta: 0, traits: 0, signals: 0 };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: { table: string; row: Record<string, unknown> };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const r = parsed.row;
      if (parsed.table === "meta") {
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)",
          String(r.key), String(r.value),
        );
        counts.meta++;
      } else if (parsed.table === "traits") {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO traits (key, value, confidence, half_life_days, updated_at, evidence_count)
           VALUES (?,?,?,?,?,?)`,
          String(r.key), Number(r.value), Number(r.confidence), Number(r.half_life_days),
          String(r.updated_at), Number(r.evidence_count),
        );
        counts.traits++;
      } else if (parsed.table === "signals") {
        this.ctx.storage.sql.exec(
          "INSERT INTO signals (ts, source_app, type, entity, value) VALUES (?,?,?,?,?)",
          String(r.ts), String(r.source_app), String(r.type),
          r.entity == null ? null : String(r.entity), r.value == null ? null : String(r.value),
        );
        counts.signals++;
      }
    }
    return counts;
  }

  // Ring-buffered access audit (cap 200 rows per user).
  async recordAudit(client: string, tool: string, nowMs = Date.now()): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO audit (at, client, tool) VALUES (?,?,?)",
      new Date(nowMs).toISOString(), client.slice(0, 60), tool.slice(0, 40),
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 200)",
    );
  }

  async getAudit(limit = 50): Promise<{ at: string; client: string; tool: string }[]> {
    return this.ctx.storage.sql
      .exec<{ at: string; client: string; tool: string }>(
        "SELECT at, client, tool FROM audit ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(1, limit), 200),
      )
      .toArray();
  }

  // The compact brief a client injects into a prompt (SOURCE_STRATEGIES 4.8):
  // decayed traits COMPILED into a handful of numeric dials plus the top desk
  // affinities — never a raw trait dump.
  async getContext(nowMs = Date.now()): Promise<{
    name: string | null;
    state: { value: string; ageMinutes: number } | null;
    place: string | null;
    dials: { DEPTH: number; INTERRUPT_THRESHOLD: number; LEVITY: number };
    topDesks: { desk: string; weight: number }[];
  }> {
    const cfg = await this.getConfig();
    const meta = new Map(
      this.ctx.storage.sql
        .exec<{ key: string; value: string }>(
          "SELECT key, value FROM meta WHERE key IN ('state','state_at','place')",
        )
        .toArray()
        .map((r) => [r.key, r.value]),
    );
    const stateAt = Number(meta.get("state_at") ?? 0);
    const state = meta.get("state")
      ? { value: meta.get("state")!, ageMinutes: Math.round((nowMs - stateAt) / 60_000) }
      : null;

    const dialOf = async (key: string, dflt: number) => {
      const t = (await this.getTraits(`dial.${key}`, nowMs))[0];
      return t ? t.value : dflt;
    };
    const dials = {
      DEPTH: await dialOf("depth", 1),
      INTERRUPT_THRESHOLD: await dialOf("interrupt_threshold", 2),
      LEVITY: await dialOf("levity", 0.5),
    };

    const topDesks = (await this.getTraits("desk.weight.", nowMs))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8)
      .map((t) => ({ desk: t.key.slice("desk.weight.".length), weight: Math.round(t.value * 100) / 100 }));

    return { name: cfg.name, state, place: meta.get("place") ?? null, dials, topDesks };
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
