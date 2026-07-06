// Bindings for wire-api. Keep in sync with wrangler.toml — the boot check in
// index.ts fails loudly on any missing binding (V3_BLUEPRINT §9).

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  BACKUPS: R2Bucket;
  SPEND: AnalyticsEngineDataset;
  NEWSROOM: DurableObjectNamespace;
  PROFILES: DurableObjectNamespace;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  // Workers AI (embeddings). Optional at runtime by design: absence or
  // failure degrades clustering to exact-key dedup, never costs an edition.
  AI?: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

  // Secrets (dormant-until-secret, V3_BLUEPRINT §9):
  INGEST_SECRET?: string; // arms POST /api/ingest
  NTFY_TOPIC?: string; // arms Worker-originated phone alerts (RUNBOOK §2)

  // Plain vars:
  VALIDATE_LIVENESS?: string; // "off" skips network validation (tests/dev only)
}

// Keys the Worker requires at boot. Secrets stay optional by design.
export const REQUIRED_BINDINGS = [
  "KV",
  "DB",
  "BACKUPS",
  "SPEND",
  "NEWSROOM",
  "PROFILES",
] as const;
