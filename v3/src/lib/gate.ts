// The single rate-limit primitive replacing v2's throttle-key zoo, with the
// two audited gate bugs designed out:
//  - SUCCESS-ONLY COUNTING: a failed attempt never consumes quota (v2's daily
//    cap counted attempts, so a bad morning starved the evening cron).
//  - NO WEDGED GATES: pending markers carry a TTL, so a crashed run can only
//    ever delay the next attempt, never block it forever (v2's poll gate
//    meant Refresh never delivered after one lost generation).

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface GateResult {
  allowed: boolean;
  reason?: "throttled" | "daily-cap";
  retryAfterSec?: number;
}

// Min-interval throttle per key. Records the moment of a SUCCESSFUL pass only
// (call recordSuccess after the guarded work commits).
export async function checkThrottle(
  kv: KVLike,
  key: string,
  minIntervalSec: number,
  nowSec: number,
): Promise<GateResult> {
  const last = Number((await kv.get(`gate:t:${key}`)) ?? 0);
  if (last && nowSec - last < minIntervalSec) {
    return { allowed: false, reason: "throttled", retryAfterSec: minIntervalSec - (nowSec - last) };
  }
  return { allowed: true };
}

// Daily cap per key (calendar-day bucket supplied by the caller so the
// London-day boundary lives in one place). Counts successes only.
export async function checkDailyCap(
  kv: KVLike,
  key: string,
  day: string,
  max: number,
): Promise<GateResult> {
  const n = Number((await kv.get(`gate:d:${key}:${day}`)) ?? 0);
  if (n >= max) return { allowed: false, reason: "daily-cap" };
  return { allowed: true };
}

// Call AFTER the guarded work succeeds: stamps the throttle and increments the
// day counter. Failures never reach here, so they never consume quota.
export async function recordSuccess(
  kv: KVLike,
  key: string,
  day: string,
  nowSec: number,
  opts?: { throttleTtlSec?: number },
): Promise<void> {
  await kv.put(`gate:t:${key}`, String(nowSec), {
    expirationTtl: Math.max(60, opts?.throttleTtlSec ?? 86400),
  });
  const dayKey = `gate:d:${key}:${day}`;
  const n = Number((await kv.get(dayKey)) ?? 0);
  await kv.put(dayKey, String(n + 1), { expirationTtl: 2 * 86400 });
}
