import { resolve } from "node:path";
import { test as base } from "@playwright/test";
import { createTestHarness, type TestHarness } from "wrangler";
import { createBrowserServer } from "./server";

type WorkerFixtures = {
  backend: TestHarness;
  browserServer: Awaited<ReturnType<typeof createBrowserServer>>;
};

type TestFixtures = {
  database: void;
};

export function createTestBackend() {
  return createTestHarness({
    root: resolve(import.meta.dirname, ".."),
    workers: [
      {
        configPath: "apps/api/wrangler.jsonc",
        env: "local",
        prebuiltWorkerDir: "apps/api/dist-test",
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
  backend: [
    // Playwright reads fixture dependencies from the destructured parameter.
    // oxlint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const backend = createTestBackend();

      try {
        await backend.listen();
        await use(backend);
      } finally {
        await backend.close();
      }
    },
    { scope: "worker", timeout: 30_000 },
  ],
  browserServer: [
    async ({ backend }, use) => {
      const browserServer = await createBrowserServer(
        backend,
        "http://127.0.0.1:3000",
      );

      try {
        await use(browserServer);
      } finally {
        await browserServer.close();
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ browserServer }, use) => {
    await use(browserServer.url);
  },
  database: [
    async ({ backend }, use, testInfo) => {
      try {
        await backend.getWorker().applyD1Migrations("DB");
        await use();
      } finally {
        if (testInfo.status !== testInfo.expectedStatus) backend.debug();
        await backend.reset();
      }
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
