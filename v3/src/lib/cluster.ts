// Story clustering (V3_BLUEPRINT §2): embed title+lede, cosine within a
// 48h window, chain clusters across days into sagas. Saga-awareness is the
// mechanism that stopped reworded repeats in v2 (commit a92c4bd).
//
// v1 honesty note: the blueprint pairs cosine with an entity-overlap check.
// Entity extraction hasn't landed, so the proxy is a shared significant
// title token (>= 4 chars) — cheap, documented, and replaceable when
// entities arrive. Thresholds are tunable constants, not folklore.

import { normTitle } from "./text";

export const SAGA_COSINE = 0.85; // same development => same saga
export const DUP_COSINE = 0.93; // near-identical within a desk => duplicate
export const CLUSTER_WINDOW_HOURS = 48;

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

const significantTokens = (title: string): Set<string> =>
  new Set(normTitle(title).split(" ").filter((t) => t.length >= 4));

export function sharesEntityProxy(titleA: string, titleB: string): boolean {
  const A = significantTokens(titleA);
  for (const t of significantTokens(titleB)) if (A.has(t)) return true;
  return false;
}

export interface RecentStory {
  story_id: string;
  saga_id: string | null;
  desk: string;
  title: string;
  vec: Float32Array | null;
}

export interface ClusterVerdict {
  kind: "duplicate" | "saga" | "new";
  sagaId: string | null; // set for "saga"; null for "new"
  matchId?: string;
}

// Compare a candidate against the recent window (newest-first is fine; the
// BEST match decides). Brute-force cosine: at ~40 stories/day this is
// microseconds — Vectorize stays a later swap (V3_BLUEPRINT §1).
export function clusterCandidate(
  candidate: { desk: string; title: string; vec: Float32Array | null },
  recent: RecentStory[],
): ClusterVerdict {
  if (!candidate.vec) return { kind: "new", sagaId: null };
  let best: { score: number; story: RecentStory } | null = null;
  for (const r of recent) {
    if (!r.vec) continue;
    const score = cosine(candidate.vec, r.vec);
    if (!best || score > best.score) best = { score, story: r };
  }
  if (!best) return { kind: "new", sagaId: null };

  const { score, story } = best;
  if (!sharesEntityProxy(candidate.title, story.title)) return { kind: "new", sagaId: null };
  if (score >= DUP_COSINE && story.desk === candidate.desk) {
    return { kind: "duplicate", sagaId: story.saga_id ?? story.story_id, matchId: story.story_id };
  }
  if (score >= SAGA_COSINE) {
    return { kind: "saga", sagaId: story.saga_id ?? story.story_id, matchId: story.story_id };
  }
  return { kind: "new", sagaId: null };
}

// Float32Array <-> BLOB helpers for the stories.embedding column.
export const vecToBlob = (v: Float32Array): Uint8Array =>
  new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));

export const blobToVec = (b: ArrayBuffer | Uint8Array | null): Float32Array | null => {
  if (!b) return null;
  const u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (u8.byteLength === 0 || u8.byteLength % 4 !== 0) return null;
  return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
};
