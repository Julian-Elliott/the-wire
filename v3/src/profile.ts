import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// ProfileDO ("Persona") — one per user, keyed idFromName(userId)
// (V3_BLUEPRINT §4). Derivation is strictly one-directional:
// signals → traits → policies. Skeleton: schema + ping(); the decay alarm,
// tool surface and policy evaluation land in Phase 1 proper.
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
          value          TEXT NOT NULL,
          confidence     REAL NOT NULL DEFAULT 0,
          half_life_days REAL NOT NULL DEFAULT 30,
          updated_at     TEXT NOT NULL,
          evidence_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    });
  }

  async ping(): Promise<{ ok: true; signals: number; traits: number }> {
    const signals = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM signals")
      .one().n;
    const traits = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM traits")
      .one().n;
    return { ok: true, signals, traits };
  }
}
