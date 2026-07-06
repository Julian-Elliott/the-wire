import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // Same migrations CI applies to prod (deploy-v3.yml) — tests run the real schema.
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        // env.test = production bindings minus [ai] (remote-proxied, so it must
        // never be reachable from tests — hermetic and CI-safe).
        wrangler: { configPath: "./wrangler.toml", environment: "test" },
        miniflare: {
          bindings: {
            INGEST_SECRET: "test-secret",
            VALIDATE_LIVENESS: "off", // network validation is unit-tested with an injected fetcher
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/setup.ts"],
    },
  };
});
