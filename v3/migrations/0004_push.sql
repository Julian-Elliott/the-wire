-- Web Push subscriptions (personas' #2: interrupts must reach all users, not
-- just the operator's ntfy topic). One row per browser subscription; a user
-- may have several (phone + laptop). endpoint is the push-service URL; p256dh
-- + auth are the subscription's public key material for RFC 8291 encryption.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
