// Bindings for wire-api. Keep in sync with wrangler.toml — the boot check in
// index.ts fails loudly on any missing binding (V3_BLUEPRINT §9).

export interface Env {
  KV: KVNamespace;
  DB: D1Database;
  BACKUPS: R2Bucket;
  SPEND: AnalyticsEngineDataset;
  ENGAGE: AnalyticsEngineDataset;
  NEWSROOM: DurableObjectNamespace;
  PROFILES: DurableObjectNamespace;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  // Workers AI (embeddings). Optional at runtime by design: absence or
  // failure degrades clustering to exact-key dedup, never costs an edition.
  AI?: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };

  // Secrets (dormant-until-secret, V3_BLUEPRINT §9):
  INGEST_SECRET?: string; // arms POST /api/ingest
  NTFY_TOPIC?: string; // arms Worker-originated phone alerts (RUNBOOK §2)
  SESSION_SECRET?: string; // arms Sign in with Apple (with APPLE_CLIENT_ID)
  APPLE_DOMAIN_ASSOCIATION?: string; // served at /.well-known when set
  PERSONA_JWT_SECRET?: string; // arms the Persona tool surface (HS256 client tokens)

  // Plain vars:
  VALIDATE_LIVENESS?: string; // "off" skips network validation (tests/dev only)
  APPLE_CLIENT_ID?: string; // Services ID (aud) — public-safe, committed
  APPLE_REDIRECT_URI?: string;
  APPLE_TEAM_ID?: string; // shared by WeatherKit (and future MusicKit)
  WEATHERKIT_KEY_ID?: string;
  WEATHERKIT_APP_ID?: string;
  WEATHERKIT_PRIVATE_KEY?: string; // secret (.p8) — WeatherKit dormant without it
  SIGNALS_LAT?: string; // operator area for shared weather/energy sources
  SIGNALS_LON?: string;
}

// Keys the Worker requires at boot. Secrets stay optional by design.
export const REQUIRED_BINDINGS = [
  "KV",
  "DB",
  "BACKUPS",
  "SPEND",
  "ENGAGE",
  "NEWSROOM",
  "PROFILES",
] as const;
