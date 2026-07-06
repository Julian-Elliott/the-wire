import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { gunzip, gzip } from "../src/lib/gz";
import type { StoredStory } from "../src/newsroom";

const e = env as Record<string, any>;

describe("gzip round-trip", () => {
  it("compresses and restores text", async () => {
    const text = "line one\nline two ünïcode";
    expect(await gunzip(await gzip(text))).toBe(text);
  });
});

describe("ProfileDO NDJSON sweep + drill import", () => {
  it("exports to R2 and re-imports losslessly", async () => {
    const ns = e.PROFILES;
    const src = ns.get(ns.idFromName("apple:backup-test")) as any;
    await src.recordSignal({ sourceApp: "wire", type: "story.read", entity: "world" });
    await src.recordSignal({ sourceApp: "wire", type: "story.starred", entity: "ev" });
    await src.importV2({ name: "Backup Test", config: { window: "48h" } });

    const { key, rows } = await src.exportToR2("apple:backup-test", "2026-07-06");
    expect(key).toBe("do/ProfileDO/apple:backup-test/2026-07-06.ndjson.gz");
    expect(rows).toBeGreaterThanOrEqual(5); // 2 signals + 2 traits + >=1 meta

    const obj = await (e.BACKUPS as R2Bucket).get(key);
    expect(obj).toBeTruthy();
    const ndjson = await gunzip(await obj!.arrayBuffer());
    expect(ndjson).toContain("desk.weight.world");

    const dst = ns.get(ns.idFromName("drill:backup-test")) as any;
    const counts = await dst.importNdjson(ndjson);
    expect(counts.traits).toBe(2);
    expect(counts.signals).toBe(2);
    const ping = await dst.ping();
    expect(ping.traits).toBe(2);
    expect(ping.signals).toBe(2);
  });
});

describe("NewsroomDO NDJSON sweep", () => {
  it("dumps stories with embeddings nulled (regenerable, not serialisable)", async () => {
    const ns = e.NEWSROOM;
    const n = ns.get(ns.idFromName("backup-newsroom")) as any;
    const story: StoredStory = {
      story_id: "bk1",
      embedding: Float32Array.from([0.1, 0.2, 0.3]),
      desk: "world",
      title: "Backup fixture story headline",
      summary: "s",
      why: null,
      url: "https://example.com/bk1",
      canon_url: "https://example.com/bk1",
      title_key: "t:world|backup fixture story headline",
      sources: [],
      salience: 10,
      priority: 1,
      published_at: null,
      quote: null,
      editorial_read: null,
      added_at: new Date().toISOString(),
    };
    await n.ingestBatch([story]);
    const { key, rows } = await n.exportToR2("2026-07-06");
    expect(rows).toBeGreaterThanOrEqual(2); // story + build_status rows
    const obj = await (e.BACKUPS as R2Bucket).get(key);
    const ndjson = await gunzip(await obj!.arrayBuffer());
    const storyLine = ndjson.split("\n").find((l) => l.includes('"bk1"'));
    expect(storyLine).toBeTruthy();
    expect(JSON.parse(storyLine!).row.embedding).toBeNull();
  });
});

describe("forced sweep door", () => {
  it("runs the full sweep on demand and reports keys", async () => {
    const res = await SELF.fetch("https://wire.databased.business/api/admin/sweep", {
      method: "POST",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    expect(b.ok).toBe(true);
    expect(b.newsroom?.key).toContain("do/NewsroomDO/main/");
    // Heartbeat lands so the backup workflow's freshness check passes.
    const hb = JSON.parse((await (e.KV as KVNamespace).get("hb:crons")) ?? "{}");
    expect(hb["do-sweep"]).toBeTruthy();
  });
});

describe("restore-drill door", () => {
  it("imports only into drill-prefixed scratch DOs", async () => {
    const ndjson = JSON.stringify({
      table: "traits",
      row: { key: "desk.weight.test", value: 1, confidence: 0.5, half_life_days: 30, updated_at: new Date().toISOString(), evidence_count: 1 },
    });
    const res = await SELF.fetch("https://wire.databased.business/api/admin/restore-drill", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test-secret" },
      body: JSON.stringify({ target: "../apple:real-user", ndjson }),
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as Record<string, any>;
    // DO names are opaque (not paths) — the forced drill: prefix is the
    // protection: no crafted target can ever name a real profile DO.
    expect(b.target.startsWith("drill:")).toBe(true);
    expect(b.target).not.toBe("apple:real-user");
    expect(b.counts.traits).toBe(1);
  });
});
