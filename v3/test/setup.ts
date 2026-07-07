import { applyD1Migrations, env } from "cloudflare:test";

// Apply the real D1 migrations (idempotent) so tests exercise the schema
// that deploy-v3.yml applies to production.
const e = env as Record<string, any>;
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS ?? []);
