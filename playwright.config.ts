import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure" },
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
  ],
});
