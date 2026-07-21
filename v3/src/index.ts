import { Hono } from "hono";
import { REQUIRED_BINDINGS, type Env } from "./env";
import {
  appleEnabled, getCookie, randHex, signToken, verifyAppleIdToken, verifyToken,
} from "./lib/auth";
import {
  PERSONA_TOOLS, verifyPersonaToken, type PersonaClaims,
} from "./lib/persona-token";
import { analyseDesk, buildCentroid, meanVector, type DeskAnalysis } from "./lib/preference";
import { rankStories, whyRanked, type RankableStory } from "./lib/rank";
import { runSignals } from "./signals";
import { dedupeBatch, isStale, titleKey, urlKey } from "./lib/dedup";
import { SUMMARY_MAX, TITLE_STORE_MAX, URL_STORE_MAX, cleanDeskId } from "./lib/text";
import { embedTexts, embeddingInput } from "./lib/embed";
import { canonHost, canonUrl } from "./lib/urls";
import { validateBatch, type IngestItem } from "./lib/validate";
import {
  ENGAGEMENT_EVENTS, PRODUCTS, isClientEvent, recordEvent, type Product,
} from "./lib/engage";
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
    feed(limit?: number, uid?: string | null): Promise<(Omit<StoredStory, "embedding"> & { saga_id: string | null })[]>;
    stats(): Promise<{ stories: number; newestAddedAt: string | null }>;
    exportToR2(dateIso: string): Promise<{ key: string; rows: number }>;
  };
};

interface PersonaVerdict {
  decision: "interrupt" | "digest" | "silent";
  reason: string;
}
interface PersonaContext {
  name: string | null;
  state: { value: string; ageMinutes: number } | null;
  place: string | null;
  dials: Record<string, number>;
  topDesks: { desk: string; weight: number }[];
}
const profileStub = (env: Env, uid: string) =>
  env.PROFILES.get(env.PROFILES.idFromName(uid)) as unknown as {
    exportToR2(uid: string, dateIso: string): Promise<{ key: string; rows: number }>;
    importNdjson(text: string): Promise<{ meta: number; traits: number; signals: number }>;
    getContext(): Promise<PersonaContext>;
    getTraits(prefix?: string): Promise<{ key: string; value: number; confidence: number }[]>;
    isInterruptible(priority: 1 | 2 | 3): Promise<PersonaVerdict>;
    recordSignal(sig: { sourceApp: string; type: string; entity?: string; value?: string }): Promise<{ accepted: boolean; affectedTraits: string[] }>;
    recordAudit(client: string, tool: string): Promise<void>;
    purge(): Promise<{ ok: true; cleared: string[] }>;
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
  const secret = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : (c.req.header("x-ingest-secret") ?? c.req.header("x-ingest-key") ?? ""); // x-ingest-key = v2 routine compatibility
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
  const n = Number.isFinite(limit) ? limit : 50;
  // Anonymous callers get global stories only; a session additionally
  // unlocks stories scoped to that user (per-user triggers, §7).
  const sess = await sessionOf(c);
  const items = await newsroom(c.env).feed(n, sess?.uid ?? null);

  const shape = (s: (typeof items)[number], extra: Record<string, unknown> = {}) => ({
    id: s.story_id, saga: s.saga_id, desk: s.desk, title: s.title, summary: s.summary,
    why: s.why, url: s.url, sources: s.sources, salience: s.salience, priority: s.priority,
    quote: s.quote, publishedAt: s.published_at, addedAt: s.added_at, ...extra,
  });

  // Signed-out (or opt-out via ?order=latest): chronological, as before.
  if (!sess || c.req.query("order") === "latest") {
    return c.json({ ok: true, ranked: false, count: items.length, items: items.map((s) => shape(s)) });
  }

  // RANKED ASSEMBLY (V3_BLUEPRINT §3 L4, LLM-free): desk weight × salience ×
  // recency × trait affinity. The vectors the compass proved out now decide
  // order. Priority-3 (interrupt-tier) stories always float to the very top —
  // urgency outranks taste. Every item carries its "why you're seeing this".
  const nr = c.env.NEWSROOM.get(c.env.NEWSROOM.idFromName("main")) as unknown as NewsroomEmbeds;
  const withVecs = await nr.feedWithEmbeddings(Math.max(n, 100));
  const vecById = new Map(withVecs.map((r) => [r.story_id, r.vec]));
  const model = await buildUserModel(
    c.env, sess.uid,
    withVecs.map((r) => ({ story_id: r.story_id, desk: r.desk, vec: r.vec })),
  );

  const rankable: (RankableStory & { src: (typeof items)[number] })[] = items.map((s) => ({
    id: s.story_id,
    desk: s.desk,
    salience: s.salience,
    addedAtMs: Date.parse(s.added_at) || Date.now(),
    vec: vecById.get(s.story_id) ? Float32Array.from(vecById.get(s.story_id)!) : null,
    src: s,
  }));

  const ctx = {
    nowMs: Date.now(),
    deskWeight: (d: string) => model.weightByDesk.get(d) ?? 1,
    deskCentroid: (d: string) => model.centroidByDesk.get(d) ?? null,
    corpusMean: model.corpusMean,
  };
  const ranked = rankStories(rankable, ctx);

  // Priority-3 first (urgency beats taste), then by score.
  ranked.sort((a, b) => {
    const pa = a.story.src.priority === 3 ? 1 : 0;
    const pb = b.story.src.priority === 3 ? 1 : 0;
    return pb - pa || b.score - a.score;
  });

  return c.json({
    ok: true,
    ranked: true,
    count: ranked.length,
    items: ranked.slice(0, n).map((r) =>
      shape(r.story.src, {
        rankScore: Math.round(r.score * 1000) / 1000,
        rankWhy: whyRanked(r.components, r.story.desk),
      }),
    ),
  });
});

app.get("/", (c) =>
  c.json({
    service: "wire-api",
    status: "under construction — The Wire v3 foundation",
    blueprint: "https://github.com/Julian-Elliott/the-wire/blob/main/docs/V3_BLUEPRINT.md",
  }),
);

// ---- Sign in with Apple (V3_BLUEPRINT §6; ported from v2) ------------------
// Dormant until APPLE_CLIENT_ID + SESSION_SECRET exist. No client secret:
// Apple's form_post id_token is verified against Apple's JWKS directly.

const SESSION_DAYS = 90;

async function sessionOf(c: { req: { raw: Request }; env: Env }): Promise<{ uid: string; name: string | null } | null> {
  const s = await verifyToken(c.env.SESSION_SECRET, getCookie(c.req.raw, "sess"));
  if (!s || typeof s.uid !== "string") return null;
  // Apple S2S revocation (review fix): the denylist stores the revocation
  // TIMESTAMP, not a permanent tombstone. A session is killed only if it was
  // issued at/before the revocation — so a user who RE-AUTHORISES gets a
  // fresh session (iat > revokedAt) that survives, with no key deletion, and
  // the key carries a TTL so it can't outlive the longest possible session.
  // Honest bound: Workers KV is eventually consistent, so recall is
  // near-immediate (~seconds), not literally instant.
  const revoked = await c.env.KV.get(`revoked:${s.uid}`);
  if (revoked) {
    const revokedAt = Number(revoked);
    const iat = typeof s.iat === "number" ? s.iat : 0;
    if (!iat || iat <= revokedAt) return null;
  }
  return { uid: s.uid, name: typeof s.name === "string" ? s.name : null };
}

app.get("/auth/apple/login", async (c) => {
  if (!appleEnabled(c.env)) return c.text("Sign-in not configured", 404);
  const state = randHex();
  const nonce = randHex();
  const flow = await signToken(c.env.SESSION_SECRET!, {
    state, nonce, exp: Math.floor(Date.now() / 1000) + 600,
  });
  const p = new URLSearchParams({
    response_type: "code id_token",
    response_mode: "form_post",
    client_id: c.env.APPLE_CLIENT_ID!,
    redirect_uri: c.env.APPLE_REDIRECT_URI ?? "https://wire.databased.business/auth/apple/callback",
    scope: "name email",
    state, nonce,
  });
  const h = new Headers({ Location: "https://appleid.apple.com/auth/authorize?" + p.toString() });
  // SameSite=None: Apple's form_post is a cross-site POST — Lax would drop it.
  h.append("Set-Cookie", `aflow=${encodeURIComponent(flow)}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=600`);
  return new Response(null, { status: 302, headers: h });
});

app.post("/auth/apple/callback", async (c) => {
  if (!appleEnabled(c.env)) return c.text("Sign-in not configured", 404);
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return c.text("Bad request", 400);
  }
  const flow = await verifyToken(c.env.SESSION_SECRET, getCookie(c.req.raw, "aflow"));
  if (!flow || flow.state !== form.get("state")) return c.text("Invalid sign-in state", 400);
  const payload = await verifyAppleIdToken(c.env, form.get("id_token"), String(flow.nonce));
  if (!payload?.sub) return c.text("Invalid identity token", 401);
  const uid = "apple:" + payload.sub;

  // Apple sends the user's name ONLY on first authorisation — capture it into
  // the ProfileDO (v2 stored it in KV and prod shows none survived; see §11).
  let name: string | null = null;
  try {
    const u = JSON.parse(String(form.get("user") ?? "null"));
    if (u?.name) name = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ").trim() || null;
  } catch { /* no name payload */ }
  await c.env.DB.prepare("INSERT OR IGNORE INTO users (uid, created_at) VALUES (?1, ?2)")
    .bind(uid, new Date().toISOString())
    .run();
  const stub = c.env.PROFILES.get(c.env.PROFILES.idFromName(uid)) as unknown as {
    importV2(p: { name?: string }): Promise<unknown>;
    getConfig(): Promise<{ name: string | null; config: unknown }>;
  };
  if (name) await stub.importV2({ name });
  else name = (await stub.getConfig()).name;

  const nowSec = Math.floor(Date.now() / 1000);
  const sess = await signToken(c.env.SESSION_SECRET!, {
    uid, name, email: payload.email ?? null,
    iat: nowSec, // review fix: lets a re-authorised user outlive a prior revocation
    exp: nowSec + 60 * 60 * 24 * SESSION_DAYS,
  });
  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", `sess=${encodeURIComponent(sess)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * SESSION_DAYS}`);
  h.append("Set-Cookie", "aflow=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers: h });
});

app.get("/auth/apple/logout", () => {
  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", "sess=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
  return new Response(null, { status: 302, headers: h });
});

// Apple server-to-server notifications (portal: "Server-to-Server
// Notification Endpoint"). Apple POSTs {"payload": <RS256 JWT>} on account
// lifecycle events. Signature verified against the same JWKS as sign-in;
// consent-revoked / account-delete land the uid on the session denylist and
// alarm the operator (account-delete purge is a runbook action).
app.post("/auth/apple/events", async (c) => {
  if (!appleEnabled(c.env)) return c.text("not configured", 404);
  const bodyText = await readBodyBounded(c.req.raw, 32 * 1024);
  if (bodyText === null) return c.json({ ok: false }, 413);
  let jwt: unknown;
  try {
    jwt = (JSON.parse(bodyText) as { payload?: unknown }).payload;
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const payload = (await verifyAppleIdToken(c.env, jwt, undefined)) as
    | (Record<string, unknown> & { events?: string })
    | null;
  if (!payload) return c.json({ ok: false, error: "bad signature" }, 401);

  let event: { type?: string; sub?: string } = {};
  try {
    event = typeof payload.events === "string" ? JSON.parse(payload.events) : (payload.events ?? {});
  } catch { /* unknown event shape — acknowledged below */ }

  const type = String(event.type ?? "unknown");
  const sub = String(event.sub ?? "");
  if (sub && (type === "consent-revoked" || type === "account-delete")) {
    const uid = `apple:${sub}`;
    const nowIso = new Date().toISOString();
    // Store the revocation SECOND; sessions with iat <= this die. TTL a few
    // days beyond the max session so the key self-cleans (review fix).
    await c.env.KV.put(`revoked:${uid}`, String(Math.floor(Date.now() / 1000)), {
      expirationTtl: (SESSION_DAYS + 3) * 86400,
    });
    // Consent ledger: every lifecycle event is now WRITTEN DOWN (was never
    // recorded — the privacy critique's finding). The ledger is the auditable
    // record the privacy page promises.
    await c.env.DB.prepare(
      "INSERT INTO consent_ledger (user_id, client_id, action, at) VALUES (?1, 'apple-signin', ?2, ?3)",
    ).bind(uid, type, nowIso).run();

    // account-delete = ACTUAL erasure (was a runbook note; the critique's
    // sharpest finding). Wipe the ProfileDO and every app-side row keyed to
    // this user, in one pass. GDPR erasure is a real operation, not a text.
    if (type === "account-delete") {
      try {
        await profileStub(c.env, uid).purge();
      } catch { /* DO may not exist; the D1 wipes below still run */ }
      await c.env.DB.batch([
        c.env.DB.prepare("DELETE FROM read_ledger WHERE user_id = ?1").bind(uid),
        c.env.DB.prepare("DELETE FROM demotion_ledger WHERE user_id = ?1").bind(uid),
        c.env.DB.prepare("DELETE FROM users WHERE uid = ?1").bind(uid),
      ]);
    }
    alarm(
      c.env,
      c.executionCtx,
      `Apple ${type}`,
      `${uid} — sessions invalidated, consent logged${type === "account-delete" ? ", profile + ledgers ERASED" : ""}.`,
    );
  }
  return c.json({ ok: true, received: type });
});

app.get("/.well-known/apple-developer-domain-association.txt", (c) =>
  c.env.APPLE_DOMAIN_ASSOCIATION
    ? c.text(c.env.APPLE_DOMAIN_ASSOCIATION)
    : c.text("not configured", 404),
);

app.get("/api/me", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, signedIn: false }, 401);
  return c.json({ ok: true, signedIn: true, uid: sess.uid, name: sess.name });
});

// Read-state (V3_BLUEPRINT §2): the server-owned four-state ledger that
// replaced v2's client-side seen heuristics. Keys match the migration's
// (canonical URL, else desk+title) so old and new state share one space.
app.post("/api/read", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const bodyText = await readBodyBounded(c.req.raw, 16 * 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { url?: string; desk?: string; title?: string; state?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const state = String(p.state ?? "");
  if (!["delivered", "seen", "read", "dismissed"].includes(state)) {
    return c.json({ ok: false, error: "bad state" }, 400);
  }
  // Derive the ledger key the SAME way ingest does (review fix): only a
  // well-formed public URL produces a u: key that can match a stored story;
  // canonUrl never returns empty for non-empty input, so an unparseable/
  // private URL must fall through to the title key, not become a garbage
  // primary key. URL is length-clamped like ingest.
  const desk = cleanDeskId(p.desk);
  const title = String(p.title ?? "").slice(0, TITLE_STORE_MAX);
  const url = String(p.url ?? "").slice(0, URL_STORE_MAX);
  const key = safePublicUrl(url)
    ? urlKey({ url })
    : desk && title
      ? titleKey({ category: desk, title })
      : null;
  if (!key) return c.json({ ok: false, error: "no story key" }, 400);
  await c.env.DB.prepare(
    `INSERT INTO read_ledger (user_id, story_key, state, at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(user_id, story_key) DO UPDATE SET state = excluded.state, at = excluded.at`,
  ).bind(sess.uid, key, state, new Date().toISOString()).run();
  // Scorecard: read/dismissed are server-owned engagement events, derived
  // here so the ledger stays the single source of truth (V3_IDEAS_PLAN).
  if (state === "read" || state === "dismissed") {
    await recordEvent(c.env, state === "read" ? "story_read" : "story_dismissed");
  }
  return c.json({ ok: true, key, state });
});

// Engagement events (V3_IDEAS_PLAN scorecard). Anonymous by design: the
// scorecard needs pre-sign-in behaviour (search onboarding, link-outs), and
// this path stores counts only, no identifier. story_read/story_dismissed
// are refused here; they are derived from /api/read above.
app.post("/api/event", async (c) => {
  const bodyText = await readBodyBounded(c.req.raw, 4 * 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { event?: string; product?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (!isClientEvent(p.event)) return c.json({ ok: false, error: "unknown event" }, 400);
  const product: Product = (PRODUCTS as readonly string[]).includes(String(p.product))
    ? (p.product as Product)
    : "v3";
  await recordEvent(c.env, p.event, product);
  return c.json({ ok: true });
});

// Why-demoted notes (V3_BLUEPRINT §5 trust UX): the signed-in reader sees
// every priority-3 that was held back from interrupting them, and why.
// Keyed by story_id so the client joins against /api/feed/latest items.
app.get("/api/me/demotions", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const rows = await c.env.DB.prepare(
    "SELECT story_id, decision, reason, at FROM demotion_ledger WHERE user_id = ?1 ORDER BY at DESC LIMIT 100",
  ).bind(sess.uid).all<{ story_id: string; decision: string; reason: string; at: string }>();
  return c.json({ ok: true, demotions: rows.results });
});

// Home area for per-user planning triggers (§7). The user supplies it
// explicitly (§8: config the user supplied is the one coordinate exception);
// the DO rounds to 3 dp (~110 m) before storing. POST {lat, lon} sets;
// POST {lat: null} clears.
app.get("/api/me/area", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const stub = profileStub(c.env, sess.uid) as unknown as {
    getHomeArea(): Promise<{ lat: number; lon: number } | null>;
  };
  return c.json({ ok: true, area: await stub.getHomeArea() });
});

app.post("/api/me/area", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const bodyText = await readBodyBounded(c.req.raw, 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { lat?: number | null; lon?: number | null };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const stub = profileStub(c.env, sess.uid) as unknown as {
    setHomeArea(lat: number | null, lon: number | null): Promise<{ lat: number; lon: number } | null>;
  };
  if (p.lat == null || p.lon == null) {
    await stub.setHomeArea(null, null);
    return c.json({ ok: true, area: null });
  }
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return c.json({ ok: false, error: "invalid coordinates" }, 400);
  }
  return c.json({ ok: true, area: await stub.setHomeArea(lat, lon) });
});

// ---- Persona tool surface (V3_BLUEPRINT §4) --------------------------------
// One profile per user, exposed to client apps (The Wire itself, future
// Wire FM / meal-planner) as scope-gated tools. Dormant until
// PERSONA_JWT_SECRET is set. Auth: HS256 bearer token minted by the admin
// CLI, carrying scopes + optional uid pin; the client registry (D1) is the
// revocation surface (delete the row). Every call appends to the user's
// audit ring buffer.

async function personaAuth(
  c: { req: { header(n: string): string | undefined }; env: Env },
  needScope: string,
): Promise<{ claims: PersonaClaims } | { error: Response }> {
  if (!c.env.PERSONA_JWT_SECRET) {
    return { error: Response.json({ ok: false, error: "persona dormant" }, { status: 503 }) };
  }
  const auth = c.req.header("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const claims = await verifyPersonaToken(c.env.PERSONA_JWT_SECRET, token);
  if (!claims) return { error: Response.json({ ok: false, error: "unauthorised" }, { status: 401 }) };
  // Registry check = revocation (deleting the client row kills its tokens).
  const row = await c.env.DB.prepare("SELECT client_id FROM clients WHERE client_id = ?1")
    .bind(claims.sub).first();
  if (!row) return { error: Response.json({ ok: false, error: "client revoked" }, { status: 401 }) };
  if (!claims.scopes.includes(needScope)) {
    return { error: Response.json({ ok: false, error: `missing scope ${needScope}` }, { status: 403 }) };
  }
  return { claims };
}

// The uid a call targets. Privacy critique fix — no god-key: a uid-pinned
// token may act ONLY on its own user; an unpinned token may name another uid
// ONLY if it carries the explicit "cross-user" scope (for a genuine
// multi-user client like the routine). Without that scope an unpinned token
// is refused — one operator token can no longer read all 20 profiles via
// ?uid=.
function personaUid(claims: PersonaClaims, requested: string | undefined): string | null {
  if (claims.uid) return !requested || requested === claims.uid ? claims.uid : null;
  if (!claims.scopes.includes("cross-user")) return null;
  return requested && /^apple:[A-Za-z0-9._-]{1,80}$/.test(requested) ? requested : null;
}

// Self-service transparency (power-user critique): a signed-in user reads
// their OWN Persona data with no client token — the "why you're seeing this"
// surface. Returns the session uid, or null to fall through to token auth.
async function personaSelf(c: { req: { raw: Request }; env: Env }): Promise<string | null> {
  const s = await sessionOf(c);
  return s?.uid ?? null;
}

// Tool list, filtered to the caller's scopes (§8: unscoped tools are invisible).
app.get("/api/persona/tools", async (c) => {
  if (!c.env.PERSONA_JWT_SECRET) return c.json({ ok: false, error: "persona dormant" }, 503);
  const auth = c.req.header("authorization") ?? "";
  const claims = await verifyPersonaToken(c.env.PERSONA_JWT_SECRET, auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!claims) return c.json({ ok: false, error: "unauthorised" }, 401);
  return c.json({
    ok: true,
    client: claims.sub,
    tools: PERSONA_TOOLS.filter((t) => claims.scopes.includes(t.scope)),
  });
});

app.get("/api/persona/get_context", async (c) => {
  const self = await personaSelf(c);
  let uid: string | null;
  let client: string;
  if (self) { uid = self; client = "self"; }
  else {
    const a = await personaAuth(c, "context:read");
    if ("error" in a) return a.error;
    uid = personaUid(a.claims, c.req.query("uid"));
    client = a.claims.sub;
  }
  if (!uid) return c.json({ ok: false, error: "uid not permitted" }, 403);
  const stub = profileStub(c.env, uid);
  const ctx = await stub.getContext();
  c.executionCtx.waitUntil(stub.recordAudit(client, "get_context"));
  return c.json({ ok: true, uid, context: ctx });
});

app.get("/api/persona/get_traits", async (c) => {
  const self = await personaSelf(c);
  let uid: string | null;
  let client: string;
  if (self) { uid = self; client = "self"; }
  else {
    const a = await personaAuth(c, "traits:read");
    if ("error" in a) return a.error;
    uid = personaUid(a.claims, c.req.query("uid"));
    client = a.claims.sub;
  }
  if (!uid) return c.json({ ok: false, error: "uid not permitted" }, 403);
  const stub = profileStub(c.env, uid);
  const traits = await stub.getTraits(c.req.query("prefix") ?? undefined);
  c.executionCtx.waitUntil(stub.recordAudit(client, "get_traits"));
  return c.json({ ok: true, uid, traits });
});

app.get("/api/persona/is_interruptible", async (c) => {
  // policy eval is a CLIENT action (deciding whether to reach a user), not a
  // self-introspection — token only, no session short-circuit.
  const a = await personaAuth(c, "policy:eval");
  if ("error" in a) return a.error;
  const uid = personaUid(a.claims, c.req.query("uid"));
  if (!uid) return c.json({ ok: false, error: "uid not permitted" }, 403);
  const pr = Number(c.req.query("priority"));
  const priority = pr === 3 ? 3 : pr === 2 ? 2 : 1;
  const stub = profileStub(c.env, uid);
  const verdict = await stub.isInterruptible(priority);
  c.executionCtx.waitUntil(stub.recordAudit(a.claims.sub, "is_interruptible"));
  return c.json({ ok: true, uid, priority, ...verdict });
});

app.post("/api/persona/record_signal", async (c) => {
  const a = await personaAuth(c, "signals:write");
  if ("error" in a) return a.error;
  const bodyText = await readBodyBounded(c.req.raw, 16 * 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { uid?: string; type?: string; entity?: string; value?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const uid = personaUid(a.claims, p.uid);
  if (!uid) return c.json({ ok: false, error: "uid not permitted" }, 403);
  if (!p.type) return c.json({ ok: false, error: "type required" }, 400);
  const stub = profileStub(c.env, uid);
  const res = await stub.recordSignal({
    sourceApp: a.claims.sub,
    type: String(p.type).slice(0, 60),
    entity: p.entity ? String(p.entity).slice(0, 80) : undefined,
    value: p.value ? String(p.value).slice(0, 200) : undefined,
  });
  c.executionCtx.waitUntil(stub.recordAudit(a.claims.sub, "record_signal"));
  return c.json({ ok: true, uid, ...res });
});

// Client registry management (machine-gated: this is operator-only, and the
// admin CLI mints the matching token). Register before minting; delete to
// revoke every token that client holds.
app.post("/api/admin/persona-client", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const bodyText = await readBodyBounded(c.req.raw, 8 * 1024);
  if (bodyText === null) return c.json({ ok: false, error: "payload too large" }, 413);
  let p: { clientId?: string; name?: string; scopes?: string[]; action?: string; uid?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const clientId = String(p.clientId ?? "").replace(/[^a-z0-9._-]/gi, "").slice(0, 60);
  if (!clientId) return c.json({ ok: false, error: "bad clientId" }, 400);
  const uid = p.uid && /^apple:[A-Za-z0-9._-]{1,80}$/.test(p.uid) ? p.uid : null;
  if (p.action === "revoke") {
    await c.env.DB.prepare("DELETE FROM clients WHERE client_id = ?1").bind(clientId).run();
    if (uid) {
      await c.env.DB.prepare(
        "INSERT INTO consent_ledger (user_id, client_id, action, at) VALUES (?1, ?2, 'revoke', ?3)",
      ).bind(uid, clientId, new Date().toISOString()).run();
    }
    return c.json({ ok: true, clientId, revoked: true });
  }
  const scopes = Array.isArray(p.scopes) ? p.scopes.map(String).slice(0, 20) : [];
  await c.env.DB.prepare(
    `INSERT INTO clients (client_id, name, scopes, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(client_id) DO UPDATE SET name = excluded.name, scopes = excluded.scopes`,
  ).bind(clientId, String(p.name ?? clientId).slice(0, 80), JSON.stringify(scopes), new Date().toISOString()).run();
  // A uid-pinned grant is a per-user consent event — record it.
  if (uid) {
    await c.env.DB.prepare(
      "INSERT INTO consent_ledger (user_id, client_id, action, at) VALUES (?1, ?2, 'grant', ?3)",
    ).bind(uid, clientId, new Date().toISOString()).run();
  }
  return c.json({ ok: true, clientId, scopes });
});

// ---- Preference-vector dev view (docs/research/PREFERENCE_VECTORS.md) -------
// "Is Persona learning you?" — per-desk positive centroids from the read
// ledger, today's edition scored by cosine, the liked-vs-skipped AUC printed.
// Session-gated: you only ever see your OWN preference data (this is also the
// eventual "why you're seeing this" transparency surface).

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface NewsroomEmbeds {
  embeddingsFor(ids: string[]): Promise<{ story_id: string; desk: string; title: string; vec: number[] | null }[]>;
  feedWithEmbeddings(limit?: number): Promise<{ story_id: string; desk: string; title: string; vec: number[] | null }[]>;
}

// The per-user taste model shared by the compass and the ranked feed: the
// corpus mean (anisotropy centring), a mean-centred positive centroid per
// desk (built from 'read' history), and the passport desk weights. Built
// LLM-free from data already in hand.
async function buildUserModel(
  env: Env,
  uid: string,
  current: { story_id: string; desk: string; vec: number[] | null }[],
): Promise<{
  corpusMean: Float32Array | null;
  centroidByDesk: Map<string, Float32Array>;
  weightByDesk: Map<string, number>;
  likedIds: Set<string>;
}> {
  const ledger = await env.DB
    .prepare("SELECT story_key, state FROM read_ledger WHERE user_id = ?1 AND state = 'read' LIMIT 2000")
    .bind(uid)
    .all<{ story_key: string; state: string }>();
  const likedIds = new Set(await Promise.all(ledger.results.map((r) => sha256Hex(r.story_key))));

  const nr = env.NEWSROOM.get(env.NEWSROOM.idFromName("main")) as unknown as NewsroomEmbeds;
  const liked = likedIds.size ? await nr.embeddingsFor([...likedIds]) : [];

  const allVecs: Float32Array[] = [];
  for (const r of liked) if (r.vec) allVecs.push(Float32Array.from(r.vec));
  for (const r of current) if (r.vec) allVecs.push(Float32Array.from(r.vec));
  const corpusMean = meanVector(allVecs);

  const likedByDesk = new Map<string, Float32Array[]>();
  for (const r of liked) {
    if (!r.vec) continue;
    (likedByDesk.get(r.desk) ?? likedByDesk.set(r.desk, []).get(r.desk)!).push(Float32Array.from(r.vec));
  }
  const centroidByDesk = new Map<string, Float32Array>();
  if (corpusMean) {
    for (const [desk, vecs] of likedByDesk) {
      const cen = buildCentroid(vecs, corpusMean);
      if (cen) centroidByDesk.set(desk, cen);
    }
  }

  const profile = profileStub(env, uid);
  const weightByDesk = new Map(
    (await profile.getTraits("desk.weight.")).map((t) => [t.key.slice("desk.weight.".length), t.value]),
  );
  return { corpusMean, centroidByDesk, weightByDesk, likedIds };
}

app.get("/api/dev/preference", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  try {

  // Read ledger → behaviour labels. read/dismissed are strong; seen is weak
  // (migrated v2 records are 'seen'); we treat read as liked, dismissed as
  // an explicit skip, seen as a soft skip.
  const ledger = await c.env.DB
    .prepare("SELECT story_key, state FROM read_ledger WHERE user_id = ?1 LIMIT 2000")
    .bind(sess.uid)
    .all<{ story_key: string; state: string }>();
  const behaviourByStoryId = new Map<string, "liked" | "skipped">();
  await Promise.all(
    ledger.results.map(async (r) => {
      const id = await sha256Hex(r.story_key);
      behaviourByStoryId.set(id, r.state === "read" ? "liked" : "skipped");
    }),
  );

  const nr = c.env.NEWSROOM.get(c.env.NEWSROOM.idFromName("main")) as unknown as {
    embeddingsFor(ids: string[]): Promise<{ story_id: string; desk: string; title: string; vec: number[] | null }[]>;
    feedWithEmbeddings(limit?: number): Promise<{ story_id: string; desk: string; title: string; vec: number[] | null }[]>;
  };

  // Liked/skipped story embeddings (from the ledger) + the current edition.
  const [labelled, current] = await Promise.all([
    nr.embeddingsFor([...behaviourByStoryId.keys()]),
    nr.feedWithEmbeddings(100),
  ]);

  // Corpus mean over EVERY embedding we have in hand (anisotropy centring).
  const allVecs: Float32Array[] = [];
  for (const r of [...labelled, ...current]) if (r.vec) allVecs.push(Float32Array.from(r.vec));
  const corpusMean = meanVector(allVecs);
  if (!corpusMean) {
    return c.json({ ok: true, uid: sess.uid, desks: [], note: "no embeddings yet — read some stories" });
  }

  // Passport prior: migrated desk weights from Persona traits.
  const profile = profileStub(c.env, sess.uid);
  const weights = new Map(
    (await profile.getTraits("desk.weight.")).map((t) => [t.key.slice("desk.weight.".length), t.value]),
  );

  // Group by desk: liked embeddings feed the centroid; current stories get
  // labelled by the ledger (unseen if not in it).
  const desks = new Set<string>();
  for (const r of current) if (r.vec) desks.add(r.desk);
  const likedByDesk = new Map<string, Float32Array[]>();
  for (const r of labelled) {
    if (!r.vec || behaviourByStoryId.get(r.story_id) !== "liked") continue;
    (likedByDesk.get(r.desk) ?? likedByDesk.set(r.desk, []).get(r.desk)!).push(Float32Array.from(r.vec));
  }

  const analyses: DeskAnalysis[] = [];
  for (const desk of [...desks].sort()) {
    const currentForDesk = current
      .filter((r) => r.desk === desk && r.vec)
      .map((r) => ({
        id: r.story_id,
        title: r.title,
        vec: Float32Array.from(r.vec!),
        behaviour: behaviourByStoryId.get(r.story_id) ?? ("unseen" as const),
      }));
    analyses.push(
      analyseDesk(desk, likedByDesk.get(desk) ?? [], corpusMean, currentForDesk, weights.get(desk) ?? null),
    );
  }

  return c.json({ ok: true, uid: sess.uid, dims: corpusMean.length, desks: analyses });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? `${e.message}` : String(e) }, 500);
  }
});

// Per-user Persona audit — the signed-in user sees who read what.
// Scorecard rollup for /dev/scorecard (V3_IDEAS_PLAN). Session-gated like
// the compass. Last 14 days of engagement_daily, plus read-ledger day counts
// so depth (read vs dismissed) sits next to the client-sent events.
app.get("/api/dev/scorecard", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const days = await c.env.DB.prepare(
    "SELECT day, event, product, count FROM engagement_daily WHERE day >= date('now', '-13 days') ORDER BY day DESC, event",
  ).all<{ day: string; event: string; product: string; count: number }>();
  const ledger = await c.env.DB.prepare(
    "SELECT substr(at, 1, 10) AS day, state, COUNT(*) AS count FROM read_ledger WHERE at >= datetime('now', '-14 days') GROUP BY day, state ORDER BY day DESC",
  ).all<{ day: string; state: string; count: number }>();
  return c.json({ ok: true, events: ENGAGEMENT_EVENTS, days: days.results, ledger: ledger.results });
});

app.get("/api/persona/audit", async (c) => {
  const sess = await sessionOf(c);
  if (!sess) return c.json({ ok: false, error: "sign in required" }, 401);
  const stub = profileStub(c.env, sess.uid) as unknown as { getAudit(limit?: number): Promise<{ at: string; client: string; tool: string }[]> };
  return c.json({ ok: true, audit: await stub.getAudit(50) });
});

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

// Any uncaught throw becomes a clean 500 JSON, never a raw stack (review fix:
// backstop for the getCookie/URIError class and anything else).
app.onError((err, c) => {
  console.error("wire-api error:", err instanceof Error ? err.message : String(err));
  return c.json({ ok: false, error: "internal error" }, 500);
});

// Nightly DO sweep (RUNBOOK §4): NewsroomDO dumps itself, then every known
// ProfileDO via the users registry. Failures alarm — a backup that silently
// stopped is worse than none. Also runnable on demand via /api/admin/sweep.
async function nightlySweep(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<{ newsroom: { key: string; rows: number } | null; profiles: { key: string; rows: number }[]; failures: string[] }> {
  const dateIso = new Date().toISOString().slice(0, 10);
  const failures: string[] = [];
  let newsroomOut: { key: string; rows: number } | null = null;
  const profiles: { key: string; rows: number }[] = [];
  try {
    newsroomOut = await newsroom(env).exportToR2(dateIso);
  } catch (e) {
    failures.push(`newsroom: ${e instanceof Error ? e.message : "unknown"}`);
  }
  try {
    const users = await env.DB.prepare("SELECT uid FROM users").all<{ uid: string }>();
    for (const { uid } of users.results) {
      try {
        profiles.push(await profileStub(env, uid).exportToR2(uid, dateIso));
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
  return { newsroom: newsroomOut, profiles, failures };
}

// Force-run the sweep (RUNBOOK §4: "back up now" before risky operations).
app.post("/api/admin/sweep", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const result = await nightlySweep(c.env, c.executionCtx);
  return c.json({ ok: result.failures.length === 0, ...result });
});

// Operator purge of specific stories (trigger spam / bad batch recovery).
app.post("/api/admin/purge-stories", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const bodyText = await readBodyBounded(c.req.raw, 32 * 1024);
  if (bodyText === null) return c.json({ ok: false }, 413);
  let p: { ids?: string[] };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  if (!Array.isArray(p.ids) || !p.ids.length) return c.json({ ok: false, error: "no ids" }, 400);
  const stub = c.env.NEWSROOM.get(c.env.NEWSROOM.idFromName("main")) as unknown as {
    deleteStories(ids: string[]): Promise<{ deleted: number }>;
  };
  const res = await stub.deleteStories(p.ids.map(String));
  return c.json({ ok: true, ...res });
});

// Force-run the signals poll on demand (V3_BLUEPRINT §7) — verification and
// the interrupt-tier proof without waiting for the 30-minute cron.
app.post("/api/admin/signals", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const testInterrupt = c.req.query("test") === "interrupt";
  const result = await runSignals(c.env, c.executionCtx, { testInterrupt });
  return c.json({ ok: true, ...result });
});

// Report a coarse device state onto a profile (V3_BLUEPRINT §5). The iOS app
// owns this; exposed here (machine-gated) so the interrupt tier is testable
// and the trust ladder has fresh state to reason over.
app.post("/api/admin/coarse-state", async (c) => {
  const gate = await machineGate(c);
  if (gate) return gate;
  const bodyText = await readBodyBounded(c.req.raw, 4 * 1024);
  if (bodyText === null) return c.json({ ok: false }, 413);
  let p: { uid?: string; state?: string; place?: string };
  try {
    p = JSON.parse(bodyText);
  } catch {
    return c.json({ ok: false, error: "invalid JSON" }, 400);
  }
  const uid = String(p.uid ?? "");
  if (!/^apple:[A-Za-z0-9._-]{1,80}$/.test(uid)) return c.json({ ok: false, error: "bad uid" }, 400);
  const valid = ["focus", "meeting", "commuting", "workout", "asleep", "open"];
  if (!valid.includes(String(p.state))) return c.json({ ok: false, error: "bad state" }, 400);
  const stub = c.env.PROFILES.get(c.env.PROFILES.idFromName(uid)) as unknown as {
    reportState(state: string, place?: string): Promise<void>;
  };
  await stub.reportState(String(p.state), p.place ? String(p.place) : undefined);
  return c.json({ ok: true, uid, state: p.state });
});

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Two crons: the daily 03:30 sweep vs the 30-minute signals poll.
    if (controller.cron === "30 3 * * *") ctx.waitUntil(nightlySweep(env, ctx));
    else ctx.waitUntil(runSignals(env, ctx).then(() => {}));
  },
};
