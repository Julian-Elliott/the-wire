// Search relevance for the reader's search-to-desk (PRODUCT_DIRECTION Wave A #5).
// Semantic PRIMARY (raw bge-m3 query↔passage cosine — NO corpus-mean centring;
// that's for taste centroids, a fresh query is a point not a mean), lexical
// FALLBACK/floor, blended. Dual threshold: a lenient floor for the transient
// instant look, a stricter floor for the permanent feed-join. Graceful when the
// query vector is null (env.AI absent) ⇒ pure lexical, never errors. Shared by
// the instant endpoint AND the feed join so save-time and match-time agree.
import { cosine } from "./cluster";

export const SEARCH_COS_MIN = 0.42; // instant query↔passage floor for "relevant"
export const SAVED_COS_MIN = 0.5; // stricter floor for a PERMANENT feed-join
export const SEARCH_LEX_MIN = 0.5; // >= half the query tokens present = a lexical hit
export const SEARCH_CAP = 30; // instant results returned
export const MAX_SAVED_SEARCHES = 8;

// Tiny stopword set to sharpen the lexical gate. Deliberately small — we KEEP
// len>=2 tokens so EV/AI/F1/UK survive (never the len>=3 that would drop them).
const STOP = new Set(["the", "a", "an", "of", "in", "on", "for", "to", "and", "news", "latest", "update"]);

export const normalizeQuery = (s: unknown): string =>
  String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export const queryTokens = (q: string): string[] =>
  [...new Set(normalizeQuery(q).split(" ").filter((t) => t.length >= 2 && !STOP.has(t)))];

// Deterministic djb2 hash of the normalised query ⇒ "Tesla"/"tesla!" collapse to
// one id (free dedup) and a stable handle for the Remove button.
export const searchId = (q: string): string => {
  const s = normalizeQuery(q);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// Whole-token, word-boundary matching: kills "art"∈"start", "ai"∈"said". Tokens
// of length>=4 also match as a word PREFIX so inflections rescue ("flood"→
// "flooding"); short tokens (2-3) require an exact whole token. An exact-phrase
// substring floors at 0.9 for multiword proper nouns.
export function lexicalScore(qTokens: string[], haystack: string, normQ: string): number {
  // The exact-phrase floor is ONLY for genuine MULTI-word phrases ("interest
  // rates"); applying a raw substring test to a single word would reintroduce
  // the "art"∈"start" false positive the whole-token gate exists to kill.
  const phrase = normQ.includes(" ") && haystack.includes(normQ) ? 0.9 : 0;
  if (!qTokens.length) return phrase;
  const padded = " " + haystack + " ";
  let hit = 0;
  for (const t of qTokens) {
    const whole = padded.includes(" " + t + " ");
    const prefix = t.length >= 4 && padded.includes(" " + t);
    if (whole || prefix) hit++;
  }
  return Math.max(hit / qTokens.length, phrase);
}

// One story vs one query. `cosMin` is the tunable floor — the endpoint passes
// SEARCH_COS_MIN, the feed-join passes SAVED_COS_MIN (dual threshold).
export function scoreAgainstQuery(
  queryVec: Float32Array | null,
  qTokens: string[],
  normQ: string,
  storyVec: Float32Array | null,
  storyText: string, // already normalised
  cosMin: number = SEARCH_COS_MIN,
): { score: number; semantic: number; lexical: number; hit: boolean } {
  const semantic = queryVec && storyVec ? Math.max(0, cosine(queryVec, storyVec)) : 0;
  const lexical = lexicalScore(qTokens, storyText, normQ);
  const semHit = queryVec != null && storyVec != null && semantic >= cosMin;
  const lexHit = lexical >= SEARCH_LEX_MIN;
  const score = queryVec ? 0.7 * semantic + 0.3 * lexical : lexical; // AI-absent ⇒ pure lexical
  return { score, semantic, lexical, hit: semHit || lexHit };
}
