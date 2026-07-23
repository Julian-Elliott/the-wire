// Write-time entity echo (PRODUCT_DIRECTION Wave A #6): resolve surface forms
// to canonical Wikidata labels (Messi → Lionel Messi), cached in KV. Resolution
// is WARMED at write time (ingest, via waitUntil) so query time is a pure cache
// read — Wikidata's ~10 req/min shared-IP budget is never hammered. Every path
// is best-effort: any failure just means no echo, never a broken search and
// NEVER a dropped edition (ingest calls this fire-and-forget).

import type { Env } from "../env";

const WIKIDATA = "https://www.wikidata.org/w/api.php";
// Wikidata asks for a descriptive User-Agent with contact + purpose.
const UA = "TheWire/1.0 (https://wire.databased.business; ops@databased.business) personal-news";
const CACHE_TTL_SECONDS = 90 * 24 * 3600; // 90 days
const RESOLVE_TIMEOUT_MS = 2500;
// Hard cap on live lookups per ingest batch. Kept low so even two ingests in
// the same minute stay within Wikidata's ~10 req/min shared-IP budget; a global
// token bucket would be the next step only if the ingest cadence tightens.
const WARM_CAP_DEFAULT = 4;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const normalizeEntity = (t: unknown): string =>
  String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const entKey = (t: string): string => "ent:" + normalizeEntity(t);

// A canonical label comes from a PUBLIC wiki (attacker-editable), is cached for
// 90 days and returned by the API — strip control chars / angle brackets and
// clamp length so it is safe in every render sink, not just today's textContent.
const sanitizeLabel = (s: unknown): string =>
  String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);

// A few first-words / connectives / shouting-words that are capitalised for
// reasons other than being proper nouns; skipping them trims obvious noise.
const SKIP = new Set([
  "the", "a", "an", "this", "that", "these", "those", "how", "why", "what", "when",
  "where", "who", "new", "top", "best", "first", "as", "in", "on", "of", "and", "but",
  "used", "watch", "live", "exclusive", "revealed", "video", "here", "breaking",
]);

// Cheap proper-noun extraction: runs of Capitalised words (1-3 long, >=3 chars),
// no NLP. Noisy by design — the resolver's exact-name acceptance is the real
// filter. A SHOUTY (mostly-uppercase) headline carries no proper-noun signal, so
// extraction is skipped entirely rather than burning the warm budget on junk.
export function extractEntities(title: string): string[] {
  const t = String(title ?? "");
  const letters = t.replace(/[^A-Za-z]/g, "");
  if (letters.length >= 8) {
    const upper = (t.match(/[A-Z]/g) || []).length;
    if (upper / letters.length > 0.7) return []; // ALL-CAPS headline → no signal
  }
  const words = t.split(/\s+/);
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) {
      const phrase = run.join(" ").replace(/[^A-Za-z0-9 ]+/g, "").trim();
      if (phrase.length >= 3) out.push(phrase);
    }
    run = [];
  };
  for (const w of words) {
    const bare = w.replace(/[^A-Za-z0-9]/g, "");
    // A Titlecase word, or a SHORT all-caps acronym (2-5, e.g. NASA/BBC) — a long
    // all-caps token is shouting, not a name.
    const isCap = /^[A-Z][a-z0-9]/.test(bare) || /^[A-Z]{2,5}$/.test(bare);
    if (isCap && bare.length >= 2 && !SKIP.has(bare.toLowerCase())) {
      run.push(bare);
      if (run.length >= 3) flush();
    } else {
      flush();
    }
  }
  flush();
  return [...new Set(out)];
}

// Query/echo side: KV read ONLY, never a network call — fast enough for the
// live search path. Returns the canonical label only if it differs from the
// query (an echo only helps when it ADDS information), else null.
export async function entityEcho(env: Env, term: string): Promise<string | null> {
  const norm = normalizeEntity(term);
  if (norm.length < 2) return null;
  let cached: string | null = null;
  try { cached = await env.KV.get(entKey(norm)); } catch { return null; }
  if (!cached) return null; // absent or negative-cached ("")
  return normalizeEntity(cached) === norm ? null : cached;
}

// Wikidata's own top hit for a short query is often a prefix match on an
// unrelated place ("Messi" → "Messina"), and the list is peppered with "family
// name"/"given name" pseudo-entities — so we can't just trust hits[0].
const NOISE_DESC = /\b(family name|given name|surname|disambiguation|male given name|female given name)\b/i;

// The single Wikidata call. Returns: a canonical label (resolved), null
// (DEFINITIVELY no unambiguous exact-name entity — safe to negative-cache), or
// undefined (TRANSIENT failure — must NOT be cached, or a blip poisons the term
// for 90 days). Scans ALL hits, "resolve silently when unambiguous":
//   • drop fuzzy/prefix hits (query must equal a label or alias, normalised);
//   • drop the family-name / disambiguation pseudo-entities;
//   • if the query is already a real entity's LABEL, it IS canonical → return it
//     (the echo layer then shows nothing, correctly);
//   • otherwise accept an ALIAS expansion ONLY if exactly ONE distinct canonical
//     label remains (two ⇒ genuinely ambiguous ⇒ no echo).
async function wikidataLabel(term: string, fetchFn: FetchLike): Promise<string | null | undefined> {
  const url = `${WIKIDATA}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=10&search=${encodeURIComponent(term)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESOLVE_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: ctrl.signal });
    if (!res.ok) return undefined; // 429 / 503 / etc — transient, do NOT negative-cache
    const data = (await res.json()) as { search?: { label?: string; description?: string; match?: { type?: string; text?: string } }[] };
    const hits = Array.isArray(data.search) ? data.search : [];
    const norm = normalizeEntity(term);
    const exact = hits.filter((h) => {
      const mt = h.match?.type;
      return (mt === "label" || mt === "alias")
        && normalizeEntity(h.match?.text ?? "") === norm
        && sanitizeLabel(h.label) !== ""
        && !NOISE_DESC.test(String(h.description ?? ""));
    });
    if (!exact.length) return null; // definitive: query is no entity's exact name
    // Query is itself a real entity's canonical label ⇒ already canonical.
    const asLabel = exact.find((h) => normalizeEntity(h.label ?? "") === norm);
    if (asLabel) return sanitizeLabel(asLabel.label);
    // Alias expansions: accept only when they name ONE canonical entity.
    const labels = [...new Set(exact.map((h) => sanitizeLabel(h.label)).filter((l) => l && normalizeEntity(l) !== norm))];
    return labels.length === 1 ? labels[0] : null;
  } catch {
    return undefined; // network / abort / parse — transient, do NOT negative-cache
  } finally {
    clearTimeout(timer);
  }
}

// Resolve ONE term: cache-first (positive OR negative), else one Wikidata call.
// A definitive miss caches "" (90d); a TRANSIENT failure caches nothing so the
// term is retried on the next ingest (the review's poison-cache fix).
export async function resolveEntity(env: Env, term: string, fetchFn: FetchLike = fetch): Promise<string | null> {
  const key = entKey(term);
  if (key === "ent:" || normalizeEntity(term).length < 2) return null;
  let cached: string | null = null;
  try { cached = await env.KV.get(key); } catch { /* treat as miss */ }
  if (cached !== null) return cached === "" ? null : cached;
  const label = await wikidataLabel(term, fetchFn);
  if (label === undefined) return null; // transient — leave the cache untouched, retry later
  try { await env.KV.put(key, label ?? "", { expirationTtl: CACHE_TTL_SECONDS }); } catch { /* best effort */ }
  return label;
}

// WRITE-TIME warm: extract entities from a batch of titles and resolve the
// cache MISSES, HARD-capped so one ingest can never exceed Wikidata's budget.
// Best-effort + serial (polite to the shared IP). Call via waitUntil — it must
// never block or fail ingest.
export async function warmEntities(
  env: Env, titles: string[], cap = WARM_CAP_DEFAULT, fetchFn: FetchLike = fetch,
): Promise<{ resolved: number; calls: number }> {
  const seen = new Set<string>();
  let resolved = 0, calls = 0;
  for (const title of titles) {
    for (const ent of extractEntities(title)) {
      const key = entKey(ent);
      if (seen.has(key)) continue;
      seen.add(key);
      let hit: string | null = null;
      try { hit = await env.KV.get(key); } catch { continue; }
      if (hit !== null) continue; // already cached (positive or negative)
      if (calls >= cap) return { resolved, calls }; // budget guard
      calls++;
      const label = await resolveEntity(env, ent, fetchFn);
      if (label) resolved++;
    }
  }
  return { resolved, calls };
}
