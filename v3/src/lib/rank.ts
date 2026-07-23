// Ranked assembly (V3_BLUEPRINT §3 L4, LLM-free): order each user's edition
// by desk weight × salience × recency × trait affinity. This is the layer the
// persona critique found missing — the vectors the compass proved out finally
// decide what you see first. Pure + transparent: every score carries its
// components so the reader can show "why you're seeing this".

import { cosine } from "./cluster";
import { centre } from "./preference";

export interface RankableStory {
  id: string;
  desk: string;
  salience: number; // 0–100
  addedAtMs: number;
  vec: Float32Array | null;
}

export interface RankContext {
  nowMs: number;
  deskWeight: (desk: string) => number; // passport prior, default 1
  deskCentroid: (desk: string) => Float32Array | null; // mean-centred positive centroid, null if cold
  corpusMean: Float32Array | null;
}

export interface ScoreComponents {
  deskWeight: number;
  salience: number;
  recency: number;
  affinity: number; // 1 + λ·max(0, cosine); 1.0 when no vector/cold desk
  cosine: number | null; // raw cosine for transparency (null if not scored)
}

// Tunables (documented, not folklore):
const RECENCY_HALFLIFE_H = 18; // a story half-decays in ~18h
const AFFINITY_LAMBDA = 1.0; // how hard the taste vector tilts the ranking
const SALIENCE_FLOOR = 0.5; // salience 0 → 0.5×, 100 → 1.5×

export const salienceFactor = (s: number): number =>
  SALIENCE_FLOOR + Math.max(0, Math.min(100, s)) / 100;

export const recencyFactor = (ageMs: number): number =>
  Math.pow(2, -Math.max(0, ageMs) / (RECENCY_HALFLIFE_H * 3_600_000));

// Affinity: positive-only cosine tilt (never punish — the preference-vectors
// note's core rule). Cold desks (no centroid) contribute a neutral 1.0, so
// ranking degrades gracefully to weight × salience × recency.
export function affinityOf(story: RankableStory, ctx: RankContext): { factor: number; cosine: number | null } {
  const centroid = ctx.deskCentroid(story.desk);
  if (!centroid || !story.vec || !ctx.corpusMean) return { factor: 1, cosine: null };
  const cos = cosine(centroid, centre(story.vec, ctx.corpusMean));
  return { factor: 1 + AFFINITY_LAMBDA * Math.max(0, cos), cosine: cos };
}

export function scoreStory(
  story: RankableStory,
  ctx: RankContext,
): { score: number; components: ScoreComponents } {
  const deskWeight = Math.max(0.01, ctx.deskWeight(story.desk));
  const salience = salienceFactor(story.salience);
  const recency = recencyFactor(ctx.nowMs - story.addedAtMs);
  const { factor: affinity, cosine } = affinityOf(story, ctx);
  return {
    score: deskWeight * salience * recency * affinity,
    components: { deskWeight, salience, recency, affinity, cosine },
  };
}

export interface Ranked<T> {
  story: T;
  score: number;
  components: ScoreComponents;
}

export function rankStories<T extends RankableStory>(stories: T[], ctx: RankContext): Ranked<T>[] {
  return stories
    .map((s) => ({ story: s, ...scoreStory(s, ctx) }))
    .sort((a, b) => b.score - a.score);
}

// A short human "why" from the dominant component, for the reader's
// "why you're seeing this" line.
export function whyRanked(c: ScoreComponents, desk: string): string {
  const bits: string[] = [];
  if (c.deskWeight >= 1.5) bits.push(`you follow ${desk} closely`);
  else if (c.deskWeight >= 1) bits.push(`you follow ${desk}`);
  if (c.cosine != null && c.cosine > 0.15) bits.push("similar to stories you read");
  if (c.salience >= 1.3) bits.push("high-impact");
  if (c.recency >= 0.85) bits.push("just in");
  return bits.length ? bits.join(" · ") : `on your ${desk} desk`;
}

// ---- Need-to-know: stakes × scope (PRODUCT_DIRECTION Wave B) ---------------
// A story is "need to know" for a user when it has real STAKES *and* a concrete
// anchor in that user's SCOPE. These bound the "Worth knowing" band so it can
// never become a firehose: at most NEED_MARK_CAP marks per edition.
export const NEED_THRESHOLD = 0.5; // both real stakes AND a concrete anchor required
export const NEED_MARK_CAP = 3; // ≤3 "Worth knowing" marks per edition

// A story's stakes ∈ [0,1] from fields the feed already carries. impact_class-
// ready: when the Routine adds story.impact_class this becomes
// max(salience/100, IMPACT_MAP[impactClass] ?? 0) — a one-line change.
export function stakesOf(salience: number, priority: number): number {
  const p = priority === 3 ? 1 : priority === 2 ? 0.5 : 0;
  return Math.max(Math.max(0, Math.min(100, salience)) / 100, p);
}
