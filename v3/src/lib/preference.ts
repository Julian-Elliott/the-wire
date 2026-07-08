// Preference-vector analysis (docs/research/PREFERENCE_VECTORS.md). Pure maths
// for the dev "is it learning?" view: per-desk positive centroids with
// mean-centring (the anisotropy fix — raw cosine on sentence embeddings is a
// blob without it), cosine scoring, and the liked-vs-skipped AUC that is the
// single most decision-useful number (0.5 = learned nothing; drift upward =
// the vector is tracking you).
//
// This is the honest first cut the note recommends: positive centroids +
// AUC, NOT the 2D scatter. Below ~20 positives a desk's vector is unreliable
// and flagged rather than trusted (shrinkage to the passport prior).

import { cosine } from "./cluster";

export const POSITIVE_MIN = 8; // below this, the vector is "warming up"
export const POSITIVE_TRUSTED = 20; // the note's reliability threshold

export function meanVector(vecs: Float32Array[]): Float32Array | null {
  if (!vecs.length) return null;
  const d = vecs[0].length;
  const out = new Float32Array(d);
  for (const v of vecs) for (let i = 0; i < d; i++) out[i] += v[i];
  for (let i = 0; i < d; i++) out[i] /= vecs.length;
  return out;
}

// Subtract the corpus mean (all-but-the-top, lite): removes the dominant
// common direction so cosine actually discriminates.
export function centre(v: Float32Array, mean: Float32Array): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mean[i];
  return out;
}

// Positive-only centroid (never subtract dislikes from the taste vector — the
// note's core modification), mean-centred.
export function buildCentroid(positives: Float32Array[], corpusMean: Float32Array): Float32Array | null {
  if (!positives.length) return null;
  return meanVector(positives.map((v) => centre(v, corpusMean)));
}

// AUC via the Mann-Whitney U statistic: P(a random liked story scores above a
// random skipped one). Ties count as 0.5. Undefined (null) if either side is
// empty.
export function auc(likedScores: number[], skippedScores: number[]): number | null {
  if (!likedScores.length || !skippedScores.length) return null;
  let wins = 0;
  for (const a of likedScores) {
    for (const b of skippedScores) {
      if (a > b) wins += 1;
      else if (a === b) wins += 0.5;
    }
  }
  return wins / (likedScores.length * skippedScores.length);
}

export interface ScoredStory {
  id: string;
  title: string;
  behaviour: "liked" | "skipped" | "unseen";
  cosine: number;
}

export interface DeskAnalysis {
  desk: string;
  positives: number; // count feeding the centroid
  status: "trusted" | "warming" | "cold";
  auc: number | null;
  passportWeight: number | null;
  stories: ScoredStory[]; // current-edition stories, scored, sorted high→low
}

// The whole computation for one desk: centroid from liked embeddings, score
// today's stories, AUC over the labelled ones.
export function analyseDesk(
  desk: string,
  liked: Float32Array[],
  corpusMean: Float32Array,
  current: { id: string; title: string; vec: Float32Array; behaviour: "liked" | "skipped" | "unseen" }[],
  passportWeight: number | null,
): DeskAnalysis {
  const centroid = buildCentroid(liked, corpusMean);
  const stories: ScoredStory[] = current
    .map((s) => ({
      id: s.id,
      title: s.title,
      behaviour: s.behaviour,
      cosine: centroid ? cosine(centroid, centre(s.vec, corpusMean)) : 0,
    }))
    .sort((a, b) => b.cosine - a.cosine);

  const likedScores = stories.filter((s) => s.behaviour === "liked").map((s) => s.cosine);
  const skippedScores = stories.filter((s) => s.behaviour === "skipped").map((s) => s.cosine);

  return {
    desk,
    positives: liked.length,
    status: liked.length >= POSITIVE_TRUSTED ? "trusted" : liked.length >= POSITIVE_MIN ? "warming" : "cold",
    auc: auc(likedScores, skippedScores),
    passportWeight,
    stories,
  };
}
