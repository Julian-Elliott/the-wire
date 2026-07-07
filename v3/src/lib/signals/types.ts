// Trigger events (V3_BLUEPRINT §2): what the signal pollers emit. Triggers
// become newsroom stories (desk = source family) so the digest tier catches
// everything; priority-3 candidates additionally face the interrupt gate.

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface Trigger {
  source: string; // "weatherkit" | "open-meteo" | "octopus" | "carbon" | "planit"
  desk: "weather" | "energy" | "planning";
  dedupKey: string; // same key = same event; content-addresses the story id
  title: string;
  summary: string;
  why: string; // the trust-UX "why" carried into any interrupt
  url: string; // link out to the source
  priority: 1 | 2 | 3;
  expiresHours: number;
}

export interface PollerResult {
  backend: string; // which backend actually answered (doctor/fallback routing)
  triggers: Trigger[];
}
