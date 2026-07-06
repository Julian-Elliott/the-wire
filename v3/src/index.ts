import { Hono } from "hono";
import { REQUIRED_BINDINGS, type Env } from "./env";
import { dedupeBatch, isStale, titleKey, urlKey } from "./lib/dedup";
import { SUMMARY_MAX, TITLE_STORE_MAX, URL_STORE_MAX, cleanDeskId } from "./lib/text";
import { embedTexts, embeddingInput } from "./lib/embed";
import { canonHost, canonUrl } from "./lib/urls";
import { validateBatch, type IngestItem } from "./lib/validate";
import type { StoredStory } from "./newsroom";

export { NewsroomDO } from "./newsroom";
export { ProfileDO } from "./profile";

const app = new Hono<{ Bindings: Env }>();

// Boot verification (V3_BLUEPRINT §9): fail loudly, not silently, on any
// missing binding. Runs once per isolate via lazy memoisation.
let bootChecked = false;
app.use("*", async (c, next) => {
  if (!bootChecked) {
    const missing = REQUIRED_BINDINGS.filter((k) => !(k in c.env) || c.env[k] == null);
    if (missing.length) {
      return c.json({ ok: false, error: `missing bindings: ${missing.join(", ")}` }, 500);
    }
    bootChecked = true;
  }
  await next();
});

const newsroom = (env: Env) => {
  const stub = env.NEWSROOM.get(env.NEWSROOM.idFromName("main"));
  return stub as unknown as {
    ingestBatch(
      rows: StoredStory[],
    ): Promise<{ inserted: number; clusterDups: number; sagaLinked: number }>;
    recentKeys(days?: number): Promise<string[]>;
    feed(limit?: number): Promise<(Omit<StoredStory, "embedding"> & { saga_id: string | null })[]>;
    stats(): Promise<{ stories: number; newestAddedAt: string | null }>;
    exportToR2(dateIso: string): Promise<{ key: string; rows: number }>;
  };
};

const profileStub = (env: Env, uid: string) =>
  env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
    exportToR2(uid: string, dateIso: string): Promise<{ key: string; rows: number }>;
    importNdjson(text: string): Promise<{ meta: number; traits: number; signals: number }>;
  };

// Worker-originated phone alert (RUNBOOK §2). Fire-and-forget, never throws.
function alarm(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  title: string,
  body: string,
): void {
  if (!env.NTFY_TOPIC) return;
  ctx.waitUntil(
    fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Priority: "high" },
      body,
    }).catch(() => {}),
  );
}

type Probe = "ok" | "fail" | "timeout";

async function probe(fn: () => Promise<unknown>, ms = 500): Promise<Probe> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("__timeout__")), ms);
      }),
    ]);
    return "ok";
  } catch (e) {
    return e instanceof Error && e.message === "__timeout__" ? "timeout" : "fail";
  } finally {
    clearTimeout(timer ?? null);
  }
}

// Health contract (RUNBOOK §3): single JSON, 503 if any store check is red.
// The NewsroomDO is the single writer for the feed, so its SQLite store is a
// first-class check — a bricked DO must turn health red (review finding).
app.get("/api/health", async (c) => {
  let newestAgeH: number | null = null;
  const [kv, d1, r2, doProbe] = await Promise.all([
    probe(() => c.env.KV.get("hb:ingest")),
    probe(() => c.env.DB.prepare("SELECT 1").first()),
    probe(() => c.env.BACKUPS.head("health-probe")),
    probe(async () => {
      const s = await newsroom(c.env).stats();
      if (s.newestAddedAt) {
        newestAgeH = Math.round(((Date.now() - Date.parse(s.newestAddedAt)) / 3_600_000) * 10) / 10;
      }
    }, 1500),
  ]);

  const lastIngest = kv === "ok" ? await c.env.KV.get("hb:ingest") : null;
  const cronHeartbeats =
    kv === "ok" ? JSON.parse((await c.env.KV.get("hb:crons")) ?? "{}") : {};

  const ok = kv === "ok" && d1 === "ok" && r2 === "ok" && doProbe === "ok";
  return c.json(
    {
      ok,
      version: c.env.CF_VERSION_METADATA?.id ?? "dev",
      checks: { kv, d1, r2, newsroom: doProbe },
      last_ingest: lastIngest,
      newest_story_age_h: newestAgeH,
      crons: cronHeartbeats,
      audio_spend_mtd_gbp: null, // wired with the audio pipeline (Phase 3)
      audio_cap_pct: null,
    },
    ok ? 200 : 503,
  );
});

// ---- ingest ---------------------------------------------------------------
// POST /api/ingest — the routine's delivery door (V3_BLUEPRINT §1).
// Dormant until INGEST_SECRET is set. Validates BEFORE persisting: recency
// gate, cross-day dedup, URL liveness, verbatim quotes, two-source rule,
// per-outlet cap. Rejects alarm rather than silently drop.

const MAX_BATCH = 60;
const MAX_SOURCES = 6;
const MAX_PER_OUTLET = 6;
const MAX_BODY_BYTES = 512 * 1024;

interface IngestPayload {
  items?: unknown[];
  editorialRead?: unknown;
}

// Bounded body read (review finding): never buffer an unbounded payload
// before enforcing the batch cap. Returns null when the cap is exceeded.
async function readBodyBounded(req: Request, maxBytes: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let got = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (got > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(got);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

// Constant-time secret comparison (review finding): compare digests so the
// internet-facing route leaks no byte-position timing.
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

// Public-host guard (review finding, SSRF): the Worker fetches these URLs
// during validation, so loopback/private/single-label hosts are refused.
const PRIVATE_HOST =
  /^(localhost|127\.|10\.|0\.|169\.254\.|192\.168\.|\[::1?\]?$)|^172\.(1[6-9]|2\d|3[01])\.|\.(local|internal)$|^[^.]+$/i;

function safePublicUrl(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol !== "https:" && protocol !== "http:") return false;
    return !PRIVATE_HOST.test(hostname);
  } catch {
    return false;
  }
}

const CTRL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;
const cleanText = (s: string) => s.replace(CTRL_CHARS, " ");

function sanitise(raw: unknown): IngestItem | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const desk = cleanDeskId(r.category ?? r.desk);
  const title = cleanText(String(r.title ?? "")).trim().slice(0, TITLE_STORE_MAX);
  const url = String(r.url ?? "").trim().slice(0, URL_STORE_MAX);
  if (!desk || !title || !safePublicUrl(url)) return null;
  const pr = Number(r.priority);
  return {
    category: desk,
    title,
    summary: cleanText(String(r.summary ?? "")).trim().slice(0, SUMMARY_MAX),
    why: r.why ? cleanText(String(r.why)).trim().slice(0, 400) : undefined,
    url,
    sources: Array.isArray(r.sources)
      ? r.sources
          .slice(0, MAX_SOURCES)
          .map((s) => String(s).slice(0, URL_STORE_MAX))
          .filter(safePublicUrl)
      : undefined,
    salience: Math.max(0, Math.min(100, Math.round(Number(r.salience) || 0))),
    priority: pr === 3 ? 3 : pr === 2 ? 2 : 1,
    publishedAt: r.publishedAt ? String(r.publishedAt).slice(0, 40) : undefined,
    quote: r.quote ? cleanText(String(r.quote)).trim().slice(0, 500) : undefined,
  };
}

async function storyId(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Shared machine-door auth for ingest + admin import (same trust domain).
async function machineGate(c: {
  req: { header(name: string): string | undefined };
  env: Env;
  json: (obj: unknown, status: 401 | 503) => Response;
}): Promise<Response | null> {
  if (!c.env.INGEST_SECRET) return c.json({ ok: false, error: "ingest dormant" }, 503);
  const auth = c.req.header("authorization") ?? "";
  const secret = auth.startsWith("Bearer ") ? auth.slice(7) : c.req.header("x-ingest-secret") ?? "";
  if (!(await safeEqual(secret, c.env.INGEST_SECRET))) {
    return c.json({ ok: false, error: "unauthorised" }, 401);
  }
  return null;
}

app.post("/api/ingest", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;

  const bodyText = await readBodyBounded(c.req.raw, MAX_BODY_BYTES);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let payload: IngestPayload;
  try {
    payload = JSON.parse(bodyText) as IngestPayload;
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  const rawItems = allItems.slice(0, MAX_BATCH);
  const overflow = allItems.length - rawItems.length; // counted, never silent
  if (!rawItems.length) return c.json({ ok: false, error: "no items" }, 400);
  const editorialRead = payload.editorialRead
    ? String(payload.editorialRead).slice(0, 400)
    : null;

  // 1. Structure + clamps (one clamp constant per field, everywhere).
  const shaped: IngestItem[] = [];
  let malformed = 0;
  for (const raw of rawItems) {
    const it = sanitise(raw);
    if (it) shaped.push(it);
    else malformed++;
  }

  // 2. Recency gate: drop only confidently-dated stale stories.
  const nowSec = Math.floor(Date.now() / 1000);
  const freshEnough = shaped.filter((it) => !isStale(it, nowSec));
  const stale = shaped.length - freshEnough.length;

  // 3. Cross-day + in-batch dedup against the newsroom's recent keys.
  const priorKeys = new Set(await newsroom(c.env).recentKeys(6));
  const { kept, dropped } = dedupeBatch(freshEnough, priorKeys);

  // 4. Liveness + quotes + two-source (network unless explicitly off).
  const skipNetwork = (c.env.VALIDATE_LIVENESS ?? "").toLowerCase() === "off";
  const outcome = await validateBatch(kept, (u, i) => fetch(u, i), {
    skipNetwork,
  });

  // 5. Per-outlet cap (SOURCE_STRATEGIES 4.4): no single feed dominates.
  const perHost: Record<string, number> = {};
  const accepted: IngestItem[] = [];
  let outletCapped = 0;
  for (const it of outcome.ok) {
    const h = canonHost(it.url) || "unknown";
    if ((perHost[h] = (perHost[h] ?? 0) + 1) > MAX_PER_OUTLET) {
      outletCapped++;
      continue;
    }
    accepted.push(it);
  }

  // 6. Embed (graceful absence: null vectors degrade clustering to
  // exact-key dedup, never cost an edition) and persist idempotently.
  const vectors = await embedTexts(
    c.env.AI,
    accepted.map((it) => embeddingInput(it.title, it.summary)),
  );
  const nowIso = new Date().toISOString();
  const rows: StoredStory[] = await Promise.all(
    accepted.map(async (it, idx) => {
      const cu = canonUrl(it.url);
      const tk = titleKey({ category: it.category, title: it.title });
      const key = urlKey({ url: it.url }) ?? tk;
      return {
        story_id: await storyId(key),
        embedding: vectors[idx],
        desk: it.category,
        title: it.title,
        summary: it.summary,
        why: it.why ?? null,
        url: it.url,
        canon_url: cu,
        title_key: tk,
        sources: it.sources ?? [],
        salience: it.salience ?? 0,
        priority: it.priority ?? 1,
        published_at: it.publishedAt ?? null,
        quote: it.quote ?? null,
        editorial_read: editorialRead,
        added_at: nowIso,
      };
    }),
  );
  const { inserted, clusterDups, sagaLinked } = rows.length
    ? await newsroom(c.env).ingestBatch(rows)
    : { inserted: 0, clusterDups: 0, sagaLinked: 0 };

  // 7. Heartbeat + alarms. Rejects and overflow are loud, never silent.
  await c.env.KV.put("hb:ingest", nowIso);
  if (outcome.rejected.length || overflow > 0) {
    // Alert bodies carry attacker-influenced titles: strip control chars and
    // newlines so nothing can forge extra alert lines (review finding).
    const safeLine = (s: string) => cleanText(s).replace(/[\r\n]+/g, " ").slice(0, 60);
    const lines = [
      ...(overflow > 0 ? [`overflow: ${overflow} items past the ${MAX_BATCH} cap`] : []),
      ...outcome.rejected.map((r) => `${r.reason}: ${safeLine(r.item.title)}`),
    ];
    alarm(c.env, c.executionCtx, "wire-api ingest rejects", lines.join("\n").slice(0, 800));
  }

  return c.json({
    ok: true,
    accepted: accepted.length,
    inserted,
    rejected: outcome.rejected.map((r) => ({ title: r.item.title, reason: r.reason })),
    demoted: outcome.demoted.length,
    sagaLinked,
    quotesStripped: outcome.unverified.map((u) => ({ title: u.item.title, reason: u.reason })),
    dropped: {
      malformed,
      stale,
      overflow,
      seen: dropped.filter((d) => d.reason === "seen-before").length,
      duplicate: dropped.filter((d) => d.reason !== "seen-before").length,
      clusterDup: clusterDups,
      outletCap: outletCapped,
    },
  });
});

// ---- v2 migration (V3_BLUEPRINT §11) ---------------------------------------
// One-off import door for scripts/migrate-v2.mjs: profile config + name into
// the user's ProfileDO, v2 seen-records into the read_ledger as 'seen'.
// Same machine secret as ingest; idempotent end to end.

const UID_RE = /^(apple:[A-Za-z0-9._-]{1,80}|shared)$/;
const MAX_SEEN_IMPORT = 600;

app.post("/api/admin/import-profile", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const bodyText = await readBodyBounded(c.req.raw, MAX_BODY_BYTES);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: {
    uid?: string;
    name?: string;
    config?: Record<string, unknown>;
    traits?: { key: string; value: number }[];
    seen?: { c?: string; t?: string; u?: string; at?: number }[];
  };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const uid = String(p.uid ?? "");
  if (!UID_RE.test(uid)) return c.json({ ok: false, error: "bad uid" }, 400);

  let traitsSeeded = 0;
  if (uid !== "shared") {
    // Registry for the nightly DO sweep (idFromName is one-way).
    await c.env.DB.prepare("INSERT OR IGNORE INTO users (uid, created_at) VALUES (?1, ?2)")
      .bind(uid, new Date().toISOString())
      .run();
  }
  if (uid !== "shared" && (p.name || p.config || p.traits?.length)) {
    const stub = c.env.PROFILES.get(c.env.PROFILES.idFromName(uid)) as unknown as {
      importV2(payload: {
        name?: string;
        config?: Record<string, unknown>;
        traits?: { key: string; value: number }[];
      }): Promise<{ ok: true; traitsSeeded: number }>;
    };
    traitsSeeded = (await stub.importV2({ name: p.name, config: p.config, traits: p.traits }))
      .traitsSeeded;
  }

  let ledgerRows = 0;
  const seen = Array.isArray(p.seen) ? p.seen.slice(0, MAX_SEEN_IMPORT) : [];
  if (seen.length) {
    const stmt = c.env.DB.prepare(
      "INSERT OR IGNORE INTO read_ledger (user_id, story_key, state, at) VALUES (?1, ?2, 'seen', ?3)",
    );
    const batch = [];
    for (const e of seen) {
      const desk = cleanDeskId(e.c);
      const title = String(e.t ?? "");
      if (!desk || !title) continue;
      const key =
        urlKey({ url: e.u }) ?? titleKey({ category: desk, title });
      const at = Number(e.at) > 0 ? new Date(Number(e.at) * 1000).toISOString() : new Date().toISOString();
      batch.push(stmt.bind(uid, key, at));
    }
    if (batch.length) {
      const results = await c.env.DB.batch(batch);
      ledgerRows = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }
  }

  return c.json({ ok: true, uid, traitsSeeded, ledgerRows });
});

app.get("/api/admin/profile", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const uid = String(c.req.query("uid") ?? "");
  if (!UID_RE.test(uid)) return c.json({ ok: false, error: "bad uid" }, 400);
  const ledger = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM read_ledger WHERE user_id = ?1",
  ).bind(uid).first<{ n: number }>();
  if (uid === "shared") return c.json({ ok: true, uid, ledgerRows: ledger?.n ?? 0 });
  const stub = c.env.PROFILES.get(c.env.PROFILES.idFromName(uid)) as unknown as {
    getConfig(): Promise<{ name: string | null; config: Record<string, unknown> | null }>;
    ping(): Promise<{ ok: true; signals: number; traits: number }>;
  };
  const [cfg, ping] = await Promise.all([stub.getConfig(), stub.ping()]);
  return c.json({
    ok: true,
    uid,
    name: cfg.name,
    hasConfig: cfg.config !== null,
    traits: ping.traits,
    signals: ping.signals,
    ledgerRows: ledger?.n ?? 0,
  });
});

app.get("/api/feed/latest", async (c) => {
  const limit = Number(c.req.query("limit") ?? 50);
  const items = await newsroom(c.env).feed(Number.isFinite(limit) ? limit : 50);
  return c.json({
    ok: true,
    count: items.length,
    items: items.map((s) => ({
      id: s.story_id,
      saga: s.saga_id,
      desk: s.desk,
      title: s.title,
      summary: s.summary,
      why: s.why,
      url: s.url,
      sources: s.sources,
      salience: s.salience,
      priority: s.priority,
      publishedAt: s.published_at,
      addedAt: s.added_at,
    })),
  });
});

app.get("/", (c) =>
  c.json({
    service: "wire-api",
    status: "under construction — The Wire v3 foundation",
    blueprint: "https://github.com/Julian-Elliott/the-wire/blob/main/docs/V3_BLUEPRINT.md",
  }),
);

// Restore-drill door (RUNBOOK §4): loads an NDJSON dump into a SCRATCH
// ProfileDO. The drill: prefix is forced server-side so a drill can never
// touch a real profile.
app.post("/api/admin/restore-drill", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const bodyText = await readBodyBounded(c.req.raw, 4 * 1024 * 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { target?: string; ndjson?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const target = `drill:${String(p.target ?? "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`;
  if (typeof p.ndjson !== "string" || !p.ndjson.trim()) {
    return c.json({ ok: false, error: "no ndjson" }, 400);
  }
  const counts = await profileStub(c.env, target).importNdjson(p.ndjson);
  return c.json({ ok: true, target, counts });
});

app.notFound((c) => c.json({ ok: false, error: "not found" }, 404));

// Nightly DO sweep (RUNBOOK §4): NewsroomDO dumps itself, then every known
// ProfileDO via the users registry. Failures alarm — a backup that silently
// stopped is worse than none.
async function nightlySweep(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
  const dateIso = new Date().toISOString().slice(0, 10);
  const failures: string[] = [];
  try {
    await newsroom(env).exportToR2(dateIso);
  } catch (e) {
    failures.push(`newsroom: ${e instanceof Error ? e.message : "unknown"}`);
  }
  try {
    const users = await env.DB.prepare("SELECT uid FROM users").all<{ uid: string }>();
    for (const { uid } of users.results) {
      try {
        await profileStub(env, uid).exportToR2(uid, dateIso);
      } catch (e) {
        failures.push(`${uid}: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  } catch (e) {
    failures.push(`users query: ${e instanceof Error ? e.message : "unknown"}`);
  }

  const heartbeats = JSON.parse((await env.KV.get("hb:crons")) ?? "{}");
  heartbeats["do-sweep"] = new Date().toISOString();
  if (failures.length) heartbeats["do-sweep-failures"] = failures.length;
  else delete heartbeats["do-sweep-failures"];
  await env.KV.put("hb:crons", JSON.stringify(heartbeats));

  if (failures.length) {
    alarm(env, ctx, "wire-api DO sweep failures", failures.join("\n").slice(0, 800));
  }
}

export default {
  fetch: app.fetch,
  scheduled(controller: { cron: string }, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "30 3 * * *") ctx.waitUntil(nightlySweep(env, ctx));
  },
};
