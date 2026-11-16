import { fileURLToPath, URL } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vite-plus";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc", environment: "local" },
      miniflare: {
        bindings: {
          ANALYSIS_STUB_SCENARIO: "success",
          VOICE_PROVIDER: "stub",
          VOICE_STUB_SCENARIO: "idle",
          TEST_MIGRATIONS: await readD1Migrations("../../packages/backend/migrations"),
        },
        workers: [
          {
            name: "voice-freight-tools",
            modules: true,
            scriptPath: fileURLToPath(new URL("../tools/dist/worker.js", import.meta.url)),
            modulesRoot: fileURLToPath(new URL("../tools/dist/", import.meta.url)),
            compatibilityDate: "2026-11-12",
            compatibilityFlags: ["nodejs_compat"],
            queueProducers: {
              ANALYSIS_QUEUE: "voice-freight-analysis",
              ANALYSIS_DEAD_LETTER: "voice-freight-analysis-dead-letter",
            },
            d1Databases: { DB: "00000000-0000-0000-0000-000000000001" },
          },
        ],
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
});
