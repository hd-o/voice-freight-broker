import { resolve } from "node:path";
import { test as base } from "@playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { createBrowserServer } from "./server";

type WorkerFixtures = {
  voiceScenario: string;
  backend: TestHarness;
};

type TestFixtures = {
  database: void;
  browserServer: Awaited<ReturnType<typeof createBrowserServer>>;
};

export function createTestBackend(voiceScenario = "workflow"): TestHarness {
  return createTestHarness({
    root: resolve(import.meta.dirname, ".."),
    workers: [
      {
        configPath: "apps/api/wrangler.jsonc",
        env: "local",
        prebuiltWorkerDir: "apps/api/dist-test",
        vars: {
          VOICE_PROVIDER: "stub",
          VOICE_STUB_SCENARIO: voiceScenario === "analysis-failure" ? "workflow" : voiceScenario,
          ANALYSIS_STUB_SCENARIO: voiceScenario === "analysis-failure" ? "failure" : "success",
        },
        secrets: { OPENAI_API_KEY: "unused-stub-key" },
      },
      {
        configPath: "apps/tools/wrangler.jsonc",
        env: "local",
        prebuiltWorkerDir: "apps/tools/dist-test",
      },
    ],
  });
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  voiceScenario: ["workflow", { scope: "worker", option: true }],
  backend: [
    async ({ voiceScenario }, use): Promise<void> => {
      const backend = createTestBackend(voiceScenario);

      try {
        await backend.listen();
        await use(backend);
      } finally {
        await backend.close();
      }
    },
    { scope: "worker", timeout: 30_000 },
  ],
  // The database dependency closes and drains this test's proxy before reset.
  browserServer: async ({ backend, database: _database }, use): Promise<void> => {
    const browserServer = await createBrowserServer(backend, "http://127.0.0.1:4173");

    try {
      await use(browserServer);
    } finally {
      await browserServer.close();
    }
  },
  baseURL: async ({ browserServer }, use): Promise<void> => {
    await use(browserServer.url);
  },
  database: [
    async ({ backend }, use, testInfo): Promise<void> => {
      try {
        await backend.getWorker().applyD1Migrations("DB");
        await use();
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) {
          backend.debug();
        }

        await backend.reset();
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
