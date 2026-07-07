// Lease lock with release-only-if-acquired semantics — the v2 audited bug:
// a finally-block deleted the lock unconditionally, so a request that FAILED
// to acquire still released the real holder's lock on its way out.
//
// D1-BACKED, deliberately (review finding): KV has no compare-and-swap and
// is eventually consistent, so a get/put/read-back dance cannot provide
// mutual exclusion — two racing callers can both "acquire". D1 executes on
// a single primary, so INSERT OR IGNORE on a PRIMARY KEY is atomic: exactly
// one caller writes the row. TTL (expires_at) is the crash backstop.

const DDL =
  "CREATE TABLE IF NOT EXISTS locks (key TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)";

let tableReady: Promise<unknown> | null = null;
const ensureTable = (db: D1Database) => (tableReady ??= db.prepare(DDL).run());

export async function acquireLock(
  db: D1Database,
  key: string,
  ttlSeconds: number,
  nowSec = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  await ensureTable(db);
  await db.prepare("DELETE FROM locks WHERE key = ?1 AND expires_at < ?2").bind(key, nowSec).run();
  const token = crypto.randomUUID();
  const res = await db
    .prepare("INSERT OR IGNORE INTO locks (key, token, expires_at) VALUES (?1, ?2, ?3)")
    .bind(key, token, nowSec + Math.max(1, ttlSeconds))
    .run();
  return res.meta.changes === 1 ? token : null;
}

export async function releaseLock(
  db: D1Database,
  key: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false; // never acquired — NEVER delete someone else's lock
  await ensureTable(db);
  const res = await db
    .prepare("DELETE FROM locks WHERE key = ?1 AND token = ?2")
    .bind(key, token)
    .run();
  return res.meta.changes === 1;
}
