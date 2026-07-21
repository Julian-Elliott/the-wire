-- Engagement scorecard rollup (V3_IDEAS_PLAN, "The scorecard"): one row per
-- (day, event, product), incremented by POST /api/event and by the
-- server-owned read/dismiss path in /api/read. Raw points also stream to the
-- wire_engagement Analytics Engine dataset (90-day retention); this table is
-- the durable record the /dev/scorecard page reads, mirroring the
-- SPEND-dataset-plus-D1-counter pattern from PLATFORM_LEVERAGE.
-- product distinguishes the v2 living lab from v3 during the comparison
-- window (the scorecard protocol is same readers, two products).
CREATE TABLE IF NOT EXISTS engagement_daily (
  day     TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  event   TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT 'v3',
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, product)
);
CREATE INDEX IF NOT EXISTS idx_engagement_day ON engagement_daily(day);
