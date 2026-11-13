import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
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
      name: "static",
      testIgnore: "identity.spec.ts",
      use: { baseURL: "http://127.0.0.1:4173" },
    },
    {
      name: "development",
      workers: 1,
      testMatch: ["hydration.spec.ts", "identity.spec.ts"],
      use: { baseURL: "http://127.0.0.1:3000" },
    },
  ],
  webServer: [
    {
      command: "pnpm preview",
      url: "http://127.0.0.1:4173",
      timeout: 60_000,
    },
    {
      command: "pnpm storybook --ci",
      url: "http://127.0.0.1:6006",
      timeout: 60_000,
    },
    {
      command: "pnpm dev:web",
      url: "http://127.0.0.1:3000",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm db:migrate && pnpm dev:workers",
      url: "http://127.0.0.1:8787/api/health",
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
