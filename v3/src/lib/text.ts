// Title normalisation + near-duplicate detection, ported from v2 with the
// audited clamp bug fixed: v2 clamped titles to 240 at ingest but 160 in the
// seen record, so long-titled stories dodged cross-day dedup. v3 has ONE
// clamp constant, applied everywhere a title enters a key.

export const TITLE_KEY_MAX = 160;
export const TITLE_STORE_MAX = 240;
export const URL_STORE_MAX = 400;
export const SUMMARY_MAX = 1200;
export const DESK_ID_MAX = 40;

export const normTitle = (t: unknown): string =>
  String(t ?? "")
    .slice(0, TITLE_KEY_MAX) // clamp BEFORE normalising — the single source of truth
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const titleTokens = (t: unknown): Set<string> =>
  new Set(normTitle(t).split(" ").filter((x) => x.length > 2));

// Near-duplicate titles (the SAME development reworded by another outlet):
// Jaccard overlap of title tokens >= .6. Exact-key dedup can't catch these
// because the URL and wording both differ. Titles under 3 tokens never match
// (too little signal — "FTSE 100" style short titles).
export function nearDupTitle(a: unknown, b: unknown): boolean {
  const A = titleTokens(a);
  const B = titleTokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

export const cleanDeskId = (k: unknown): string =>
  String(k ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, DESK_ID_MAX);
