import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  globalSetup: "./tests/setup.ts",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    channel: "chromium",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "public",
      testIgnore: [
        "identity.spec.ts",
        "access.spec.ts",
        "isolation.spec.ts",
        "live.spec.ts",
        "analysis.spec.ts",
        "confirmation.spec.ts",
        "confirmation-change.spec.ts",
        "budget-*.spec.ts",
      ],
      use: { baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "integration",
      testMatch: [
        "identity.spec.ts",
        "access.spec.ts",
        "isolation.spec.ts",
        "live.spec.ts",
        "analysis.spec.ts",
        "confirmation.spec.ts",
        "confirmation-change.spec.ts",
        "budget-*.spec.ts",
      ],
      use: { baseURL: "http://127.0.0.1:4173" },
    },
  ],
  webServer: [
    {
      command: process.env.BROWSER_TEST_PREBUILT
        ? "pnpm preview"
        : "pnpm --filter @voice-freight/web build && pnpm preview",
      url: "http://127.0.0.1:4173",
      timeout: 120_000,
    },
    {
      command: process.env.BROWSER_TEST_PREBUILT
        ? "python3 -m http.server 6006 --bind 127.0.0.1 --directory apps/web/storybook-static"
        : "pnpm storybook --ci",
      url: "http://127.0.0.1:6006",
      timeout: 60_000,
    },
  ],
});
