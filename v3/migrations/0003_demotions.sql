-- Demotion ledger (V3_BLUEPRINT §5 trust UX): every policy-demoted
-- priority-3 trigger is WRITTEN DOWN so the digest/reader can show its
-- "why demoted" note — silent suppression must be inspectable behaviour.
-- Lives in The Wire's own D1, not Persona, for the same reason as
-- read_ledger (§2): delivery state is app plumbing, not profile.
CREATE TABLE IF NOT EXISTS demotion_ledger (
  user_id  TEXT NOT NULL,
  story_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('digest','silent')),
  reason   TEXT NOT NULL,
  at       TEXT NOT NULL,
  PRIMARY KEY (user_id, story_id)
);
CREATE INDEX IF NOT EXISTS idx_demotions_user ON demotion_ledger(user_id, at);
