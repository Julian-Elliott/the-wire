// Engagement scorecard (V3_IDEAS_PLAN, "The scorecard"): a small fixed event
// vocabulary, double-written to the wire_engagement Analytics Engine dataset
// (raw points, 90-day retention) and to the engagement_daily D1 rollup (the
// permanent record /dev/scorecard reads). Mirrors the SPEND-plus-D1-counter
// pattern from PLATFORM_LEVERAGE. Volume is tens of events per reader-day at
// N=20, so one D1 UPSERT per event is fine; batch before N=1,000, not now.
import type { Env } from "../env";

export const ENGAGEMENT_EVENTS = [
  "edition_opened",
  "edition_finished",
  "story_read",
  "story_dismissed",
  "linkout_opened",
  "readout_played",
  "episode_completed",
  "interrupt_accepted",
  "interrupt_never_again",
  "search_onboard_started",
  "search_onboard_confirmed",
  "digest_email_opened",
  "recommendation_accepted",
] as const;
export type EngagementEvent = (typeof ENGAGEMENT_EVENTS)[number];

// story_read / story_dismissed are derived server-side from the read_ledger
// write in /api/read, the single source of truth for read-state. Accepting
// them from clients as well would double-count.
export const SERVER_OWNED_EVENTS: readonly EngagementEvent[] = [
  "story_read",
  "story_dismissed",
];

export const PRODUCTS = ["v3", "v2"] as const;
export type Product = (typeof PRODUCTS)[number];

export function isEngagementEvent(v: unknown): v is EngagementEvent {
  return typeof v === "string" && (ENGAGEMENT_EVENTS as readonly string[]).includes(v);
}

export function isClientEvent(v: unknown): v is EngagementEvent {
  return isEngagementEvent(v) && !SERVER_OWNED_EVENTS.includes(v);
}

/** UTC day bucket, YYYY-MM-DD. */
export const dayOf = (d = new Date()): string => d.toISOString().slice(0, 10);

/**
 * Record one engagement event. The AE write is best-effort (a lost raw point
 * costs nothing durable); the D1 rollup is awaited because the scorecard is
 * the record. uid is only ever hashed context for AE blobs upstream; this
 * layer stores no user identifier at all, counts only.
 */
export async function recordEvent(
  env: Env,
  event: EngagementEvent,
  product: Product = "v3",
): Promise<void> {
  try {
    env.ENGAGE.writeDataPoint({
      blobs: [event, product],
      doubles: [1],
      indexes: [event],
    });
  } catch {
    // Analytics Engine is telemetry, never load-bearing.
  }
  await env.DB.prepare(
    `INSERT INTO engagement_daily (day, event, product, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT(day, event, product) DO UPDATE SET count = count + 1`,
  ).bind(dayOf(), event, product).run();
}
