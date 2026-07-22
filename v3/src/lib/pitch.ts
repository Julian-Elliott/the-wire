// Pitch-level rendering (V3_BLUEPRINT §3 / the brief's "Liverpool fan vs
// newcomer"). Each story can carry alternative summaries; the user picks a
// level PER DESK. Level 1 (Brief) is the story's plain summary, so only the
// two variants need storing. Falls back to the summary whenever a level is
// absent — graceful until the routine emits pitches.

export const PITCH = {
  EXPLAIN: 0, // newcomer: plain, assumes no prior knowledge, reading-age ~8 (#39)
  BRIEF: 1, // default: a normal news summary (the story's `summary`)
  INSIDER: 2, // expert: terse, assumes you follow this, gets to the point / banter
} as const;

export type PitchLevel = 0 | 1 | 2;

export const PITCH_LABELS: Record<PitchLevel, string> = {
  0: "Explain it",
  1: "Normal",
  2: "Insider",
};

export const clampPitch = (n: unknown): PitchLevel => {
  const v = Math.round(Number(n));
  return v === 0 ? 0 : v === 2 ? 2 : 1;
};

export interface PitchedStory {
  summary: string;
  pitches?: { explain?: string; insider?: string } | null;
}

// The summary to show at a given level, falling back to the plain summary.
export function pickSummary(story: PitchedStory, level: PitchLevel): string {
  const p = story.pitches;
  if (level === PITCH.EXPLAIN && p?.explain) return p.explain;
  if (level === PITCH.INSIDER && p?.insider) return p.insider;
  return story.summary;
}

// Sanitise a pitches object from ingest into the stored shape (bounded text).
export function cleanPitches(
  raw: unknown,
  clean: (s: string) => string,
  max: number,
): { explain?: string; insider?: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const out: { explain?: string; insider?: string } = {};
  // Accept both named (explain/insider) and numeric (0/2) keys.
  const explain = r.explain ?? r["0"];
  const insider = r.insider ?? r["2"];
  if (typeof explain === "string" && explain.trim()) out.explain = clean(explain).trim().slice(0, max);
  if (typeof insider === "string" && insider.trim()) out.insider = clean(insider).trim().slice(0, max);
  return out.explain || out.insider ? out : null;
}
