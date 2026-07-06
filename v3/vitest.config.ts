import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          INGEST_SECRET: "test-secret",
          VALIDATE_LIVENESS: "off", // network validation is unit-tested with an injected fetcher
        },
      },
    }),
  ],
});
