// Dedup keys, batch merging and the recency gate — v2 semantics with the
// audited bugs fixed:
//  - v2's mergeItems keyed same-day dedup on the RAW lowercased URL while the
//    cross-day record used canonUrl, so utm-variant links dodged same-day
//    collapse. v3 uses the canonical URL for EVERY key.
//  - one title clamp everywhere (see text.ts).

import { nearDupTitle, normTitle } from "./text";
import { canonUrl, pubDateSec, urlDateSec } from "./urls";

export interface BriefItem {
  category: string;
  title: string;
  url?: string;
  publishedAt?: string;
}

// Desks whose card titles legitimately recur day to day (e.g. markets'
// "FTSE 100"): match by URL only, never title, so the desk still refreshes.
export const CROSSDAY_TITLE_EXEMPT: ReadonlySet<string> = new Set(["markets"]);

export const urlKey = (it: Pick<BriefItem, "url">): string | null => {
  const c = canonUrl(it?.url);
  return c ? "u:" + c : null;
};

export const titleKey = (it: Pick<BriefItem, "category" | "title">): string =>
  "t:" + (it?.category ?? "") + "|" + normTitle(it?.title);

// The keys an item is matched/recorded under: always its canonical URL (when
// present), plus its title unless the desk's titles legitimately recur.
export function matchKeys(it: BriefItem): string[] {
  const ks: string[] = [];
  const u = urlKey(it);
  if (u) ks.push(u);
  if (!CROSSDAY_TITLE_EXEMPT.has(it?.category)) ks.push(titleKey(it));
  return ks;
}

// Collapse repeats within a batch by canonical URL, exact desk+title, or
// near-duplicate title within a desk. First occurrence wins (callers order
// input newest-first). Returns survivors + what was dropped and why.
export function dedupeBatch<T extends BriefItem>(
  items: T[],
  priorKeys?: ReadonlySet<string>,
): { kept: T[]; dropped: { item: T; reason: string }[] } {
  const seen = new Set<string>();
  const keptTitles: Record<string, string[]> = {};
  const kept: T[] = [];
  const dropped: { item: T; reason: string }[] = [];

  for (const it of items) {
    const keys = matchKeys(it);
    if (priorKeys && keys.some((k) => priorKeys.has(k))) {
      dropped.push({ item: it, reason: "seen-before" });
      continue;
    }
    if (keys.some((k) => seen.has(k))) {
      dropped.push({ item: it, reason: "duplicate-in-batch" });
      continue;
    }
    if (
      !CROSSDAY_TITLE_EXEMPT.has(it.category) &&
      (keptTitles[it.category] ?? []).some((t) => nearDupTitle(t, it.title))
    ) {
      dropped.push({ item: it, reason: "near-duplicate-title" });
      continue;
    }
    for (const k of keys) seen.add(k);
    (keptTitles[it.category] ??= []).push(String(it.title ?? ""));
    kept.push(it);
  }
  return { kept, dropped };
}

// ---- recency gate ---------------------------------------------------------
// Reject genuinely STALE stories. Drop ONLY when a date is CONFIDENTLY known
// AND clearly older than a generous per-desk max-age — a legitimately recent
// or undateable story is never dropped.
export const DESK_MAX_AGE_DAYS: Record<string, number> = {
  liverpool: 7, markets: 7, world: 7, worcester: 21, gaming: 21, ev: 30,
};
export const DEFAULT_MAX_AGE_DAYS = 30;

export function isStale(it: BriefItem, nowSec: number): boolean {
  const maxAge = (DESK_MAX_AGE_DAYS[it?.category] ?? DEFAULT_MAX_AGE_DAYS) * 86400;
  const dated = pubDateSec(it?.publishedAt) ?? urlDateSec(it?.url);
  return dated != null && dated < nowSec - maxAge;
}
