import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  CLUSTER_WINDOW_HOURS,
  blobToVec,
  clusterCandidate,
  vecToBlob,
  type RecentStory,
} from "./lib/cluster";
import { CROSSDAY_TITLE_EXEMPT } from "./lib/dedup";
import { gzip } from "./lib/gz";

// NewsroomDO — the single writer for the feed (V3_BLUEPRINT §1/§2).
// Owns stories, render cells and explicit build-status rows. Saga chaining
// and embedding-based clustering arrive with the embeddings step; until
// then story identity is the content-addressed dedup key.

export interface StoredStory {
  story_id: string;
  embedding?: Float32Array | null; // set by the route, stored as BLOB
  desk: string;
  title: string;
  summary: string;
  why: string | null;
  url: string;
  canon_url: string;
  title_key: string;
  sources: string[];
  salience: number;
  priority: number;
  published_at: string | null;
  quote: string | null;
  editorial_read: string | null;
  added_at: string;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS stories (
    story_id       TEXT PRIMARY KEY,
    saga_id        TEXT,
    desk           TEXT NOT NULL,
    title          TEXT NOT NULL,
    summary        TEXT NOT NULL,
    why            TEXT,
    url            TEXT NOT NULL,
    canon_url      TEXT NOT NULL,
    title_key      TEXT NOT NULL,
    sources        TEXT NOT NULL DEFAULT '[]',
    salience       INTEGER NOT NULL DEFAULT 0,
    priority       INTEGER NOT NULL DEFAULT 1,
    published_at   TEXT,
    quote          TEXT,
    editorial_read TEXT,
    added_at       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stories_added ON stories(added_at);
  CREATE INDEX IF NOT EXISTS idx_stories_desk  ON stories(desk);
  CREATE INDEX IF NOT EXISTS idx_stories_curl  ON stories(canon_url);

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
`;

export class NewsroomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      // The pre-ingest skeleton shipped a different (empty) stories shape.
      // Rebuild when empty; PRESERVE-and-rename when data exists. Never
      // throw here (review finding): an exception inside the constructor's
      // blockConcurrencyWhile would brick every request to this DO —
      // including /api/health — with no recovery path but manual surgery.
      const cols = ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('stories')")
        .toArray()
        .map((r) => r.name);
      let renamed: string | null = null;
      if (cols.length && !cols.includes("desk")) {
        const n = ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM stories").one().n;
        if (n === 0) {
          ctx.storage.sql.exec("DROP TABLE stories");
        } else {
          renamed = `stories_legacy_${Date.now()}`;
          ctx.storage.sql.exec(`ALTER TABLE stories RENAME TO ${renamed}`);
        }
      }
      ctx.storage.sql.exec(DDL);
      if (renamed) this.logStatus("schema", "renamed", `mismatched stories with data preserved as ${renamed}`);
      // Additive migration (RUNBOOK §1): the embedding column arrived after
      // the first deploy, so existing instances gain it via ALTER.
      const cols2 = ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('stories')")
        .toArray()
        .map((r) => r.name);
      if (!cols2.includes("embedding")) {
        ctx.storage.sql.exec("ALTER TABLE stories ADD COLUMN embedding BLOB");
      }
    });
  }

  // Insert validated stories. PK = content-addressed dedup key, so replays
  // and cross-batch repeats are idempotent (OR IGNORE). Embedding-based
  // clustering runs HERE — the single writer sees a consistent recent
  // window (V3_BLUEPRINT §2): near-identical same-desk stories drop as
  // duplicates; same-development stories chain into sagas.
  async ingestBatch(
    rows: StoredStory[],
  ): Promise<{ inserted: number; clusterDups: number; sagaLinked: number }> {
    const recent = this.recentWindow();
    let inserted = 0;
    let clusterDups = 0;
    let sagaLinked = 0;

    for (const r of rows) {
      const vec = r.embedding ?? null;
      const verdict = clusterCandidate({ desk: r.desk, title: r.title, vec }, recent);
      if (verdict.kind === "duplicate") {
        clusterDups++;
        continue;
      }
      const sagaId = verdict.kind === "saga" ? verdict.sagaId : null;
      if (sagaId) sagaLinked++;

      const res = this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO stories
           (story_id, saga_id, desk, title, summary, why, url, canon_url, title_key, sources,
            salience, priority, published_at, quote, editorial_read, added_at, embedding)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        r.story_id, sagaId, r.desk, r.title, r.summary, r.why, r.url, r.canon_url, r.title_key,
        JSON.stringify(r.sources ?? []), r.salience, r.priority, r.published_at,
        r.quote, r.editorial_read, r.added_at, vec ? vecToBlob(vec) : null,
      );
      if (res.rowsWritten > 0) {
        inserted++;
        // Batch-internal chaining: later items in this batch must see this one.
        recent.push({
          story_id: r.story_id,
          saga_id: sagaId,
          desk: r.desk,
          title: r.title,
          vec,
        });
      }
    }
    this.logStatus(
      "ingest",
      "ok",
      `batch=${rows.length} inserted=${inserted} clusterDups=${clusterDups} sagas=${sagaLinked}`,
    );
    return { inserted, clusterDups, sagaLinked };
  }

  private recentWindow(): RecentStory[] {
    const cutoff = new Date(Date.now() - CLUSTER_WINDOW_HOURS * 3_600_000).toISOString();
    return this.ctx.storage.sql
      .exec<{ story_id: string; saga_id: string | null; desk: string; title: string; embedding: ArrayBuffer | null }>(
        "SELECT story_id, saga_id, desk, title, embedding FROM stories WHERE added_at >= ?",
        cutoff,
      )
      .toArray()
      .map((r) => ({
        story_id: r.story_id,
        saga_id: r.saga_id,
        desk: r.desk,
        title: r.title,
        vec: blobToVec(r.embedding),
      }));
  }

  // Cross-day dedup keys for the last `days` (V3_BLUEPRINT §2): canonical URL
  // always; title key unless the desk's titles legitimately recur.
  async recentKeys(days = 6): Promise<string[]> {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = this.ctx.storage.sql
      .exec<{ canon_url: string; title_key: string; desk: string }>(
        "SELECT canon_url, title_key, desk FROM stories WHERE added_at >= ?",
        cutoff,
      )
      .toArray();
    const keys: string[] = [];
    for (const r of rows) {
      if (r.canon_url) keys.push("u:" + r.canon_url);
      if (!CROSSDAY_TITLE_EXEMPT.has(r.desk)) keys.push(r.title_key);
    }
    return keys;
  }

  async feed(limit = 50): Promise<(Omit<StoredStory, "embedding"> & { saga_id: string | null })[]> {
    type Row = Omit<StoredStory, "sources" | "embedding"> & {
      sources: string;
      saga_id: string | null;
      embedding: ArrayBuffer | null;
    };
    const rows = this.ctx.storage.sql
      .exec<Row>(
        "SELECT * FROM stories ORDER BY added_at DESC LIMIT ?",
        Math.min(Math.max(1, limit), 200),
      )
      .toArray();
    return rows.map(({ embedding: _e, ...r }) => ({
      ...r,
      sources: JSON.parse(r.sources || "[]") as string[],
    }));
  }

  async stats(): Promise<{ stories: number; newestAddedAt: string | null }> {
    const row = this.ctx.storage.sql
      .exec<{ n: number; newest: string | null }>(
        "SELECT COUNT(*) AS n, MAX(added_at) AS newest FROM stories",
      )
      .one();
    return { stories: row.n, newestAddedAt: row.newest };
  }

  // Nightly NDJSON sweep (RUNBOOK §4): the newsroom dumps its own tables to
  // the backups bucket — DO-SQLite has no platform export, and the R2 write
  // happens HERE because a full stories dump can exceed RPC message limits.
  async exportToR2(dateIso: string): Promise<{ key: string; rows: number }> {
    const lines: string[] = [];
    for (const table of ["stories", "cells", "build_status"] as const) {
      for (const row of this.ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray()) {
        if (table === "stories" && row.embedding != null) {
          // BLOBs don't JSON-serialise; embeddings are regenerable, drop them.
          row.embedding = null;
        }
        lines.push(JSON.stringify({ table, row }));
      }
    }
    const key = `do/NewsroomDO/main/${dateIso}.ndjson.gz`;
    await this.env.BACKUPS.put(key, await gzip(lines.join("\n")));
    this.logStatus("backup", "ok", `${key} rows=${lines.length}`);
    return { key, rows: lines.length };
  }

  // Operator purge (RUNBOOK): remove specific stories by id — the recovery
  // tool for trigger spam or a bad batch. Content-addressed ids make this
  // precise; the read_ledger is untouched (seen keys still suppress repeats).
  async deleteStories(ids: string[]): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const id of ids.slice(0, 100)) {
      const res = this.ctx.storage.sql.exec("DELETE FROM stories WHERE story_id = ?", String(id));
      deleted += res.rowsWritten > 0 ? 1 : 0;
    }
    this.logStatus("purge", "ok", `deleted=${deleted}`);
    return { deleted };
  }

  logStatus(step: string, status: string, detail?: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO build_status (step, status, detail, at) VALUES (?,?,?,?)",
      step, status, detail ?? null, new Date().toISOString(),
    );
  }
}
