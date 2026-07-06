-- Registry of known ProfileDO names (RUNBOOK §4): idFromName is one-way, so
-- the nightly DO sweep needs a list of uids to fan out to. Populated by the
-- import door and every future signal-writing route.
CREATE TABLE IF NOT EXISTS users (
  uid        TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
