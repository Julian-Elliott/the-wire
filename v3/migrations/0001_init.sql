-- Wire v3 D1 schema (V3_BLUEPRINT §2). Additive-only discipline: new
-- migrations add, they never rewrite (RUNBOOK §1).

-- Read-state lives in The Wire's OWN D1, not Persona (§2): the four-state
-- ledger that kills the v2 client-side seen/hidden bug class.
CREATE TABLE IF NOT EXISTS read_ledger (
  user_id   TEXT NOT NULL,
  story_key TEXT NOT NULL,
  state     TEXT NOT NULL CHECK (state IN ('delivered','seen','read','dismissed')),
  at        TEXT NOT NULL,
  PRIMARY KEY (user_id, story_key)
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON read_ledger(user_id, at);

-- Persona client registry (§4): per-client-app scoped tokens.
CREATE TABLE IF NOT EXISTS clients (
  client_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  scopes     TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Consent ledger (§4/§8): every grant and revocation, append-only.
CREATE TABLE IF NOT EXISTS consent_ledger (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT NOT NULL,
  client_id TEXT NOT NULL,
  action    TEXT NOT NULL,
  at        TEXT NOT NULL
);

-- Permanent spend record (PLATFORM_LEVERAGE §2.5): Analytics Engine is the
-- dashboard (90-day retention); this is the ledger.
CREATE TABLE IF NOT EXISTS spend_monthly (
  month  TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (month, metric)
);
