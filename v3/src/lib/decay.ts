// Trait decay maths (V3_BLUEPRINT §2): w ← w·decay(Δt) + η·signal_strength,
// exponential with a per-trait half-life. Pure so the regression suite can
// pin the numbers without a clock.

export const decayFactor = (deltaMs: number, halfLifeDays: number): number => {
  if (!(deltaMs > 0) || !(halfLifeDays > 0)) return 1;
  return Math.pow(2, -(deltaMs / 86_400_000) / halfLifeDays);
};

export const decayed = (value: number, lastUpdatedMs: number, nowMs: number, halfLifeDays: number): number =>
  value * decayFactor(nowMs - lastUpdatedMs, halfLifeDays);

// Signal strengths for affinity traits. Dismissals are informative but must
// not nuke a long-held affinity (the preference-vectors note: three skipped
// stories must not erase a two-year interest).
export const SIGNAL_STRENGTH: Record<string, number> = {
  "story.read": 0.5,
  "story.starred": 1.0,
  "story.dismissed": -0.3,
};
