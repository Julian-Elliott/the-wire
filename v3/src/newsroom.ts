import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// NewsroomDO — the single writer for the feed (V3_BLUEPRINT §1/§2).
// Owns canonical stories, render cells and explicit build-status rows.
// Skeleton: schema + stats(); ingest/clustering land in Phase 1 proper.
export class NewsroomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS stories (
          story_id   TEXT PRIMARY KEY,
          saga_id    TEXT,
          salience   INTEGER NOT NULL DEFAULT 0,
          facts      TEXT NOT NULL,
          entities   TEXT NOT NULL DEFAULT '[]',
          timeline   TEXT NOT NULL DEFAULT '[]',
          sources    TEXT NOT NULL DEFAULT '[]',
          added_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_stories_added ON stories(added_at);
        CREATE INDEX IF NOT EXISTS idx_stories_saga  ON stories(saga_id);

        CREATE TABLE IF NOT EXISTS cells (
          cell_hash  TEXT PRIMARY KEY,
          story_id   TEXT NOT NULL,
          desk       TEXT NOT NULL,
          pitch      INTEGER NOT NULL,
          tone       TEXT NOT NULL,
          len        TEXT NOT NULL,
          prompt_ver TEXT NOT NULL,
          model_id   TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cells_story ON cells(story_id);

        CREATE TABLE IF NOT EXISTS build_status (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          step   TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT,
          at     TEXT NOT NULL
        );
      `);
    });
  }

  // Cheap liveness/summary read used by /api/health and the watchdog.
  async stats(): Promise<{ stories: number; newestAddedAt: string | null }> {
    const row = this.ctx.storage.sql
      .exec<{ n: number; newest: string | null }>(
        "SELECT COUNT(*) AS n, MAX(added_at) AS newest FROM stories",
      )
      .one();
    return { stories: row.n, newestAddedAt: row.newest };
  }
}
