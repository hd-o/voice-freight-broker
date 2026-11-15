import { expect, test } from "./fixtures";

test("a simulated multi-load call saves cancellation, replacement, transcript and final counts", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser test origin is required");
  }
  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
  ] as const) {
    expect((await request.post(path, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }
  const errors: string[] = [];
  page.on("pageerror", (error): number => errors.push(error.message));
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Simulated voice provider.", { exact: false })).toBeVisible();
  await expect(page.getByText("Yes, confirmed.", { exact: true })).toHaveCount(4, { timeout: 15_000 });
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unmute", exact: true }).click();
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await expect(page.getByRole("button", { name: "View this call in dashboard →" })).toBeVisible();
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(page.getByText("Live Call", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Call analysis" }).getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancelled agreement 1")).toBeVisible();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "NS-seed-v1-02", exact: true }).click();
  await expect(page.getByText("Replaced agreement 1")).toBeVisible();
  await expect(page.getByText("Accepted agreement 2")).toBeVisible();
  await expect(page.getByText("$2,100", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("9 calls in this population")).toBeVisible();
  await expect(
    page
      .locator("dl")
      .filter({ has: page.getByText("Final agreements", { exact: true }) })
      .locator("dd"),
  ).toHaveText("5");
  expect(errors).toEqual([]);
});

test("microphone denial leaves paid startup untouched and allows a retry", async ({ page }): Promise<void> => {
  await page.route("**/api/live/configuration", (route): Promise<void> =>
    route.fulfill({ json: { provider: "openai" } }),
  );
  await page.addInitScript((): void => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: (): Promise<never> => Promise.reject(new DOMException("Microphone denied", "NotAllowedError")),
      },
      configurable: true,
    });
  });
  let paidStarts = 0;
  page.on("request", (request): void => {
    if (new URL(request.url()).pathname === "/api/live/calls") {
      paidStarts++;
    }
  });
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Microphone access blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
  expect(paidStarts).toBe(0);
});

test("a status failure ends the call without reviving disposed audio", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser test origin is required");
  }
  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
  ] as const) {
    expect((await request.post(path, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }
  let polls = 0;
  await page.route("**/api/calls/*/live", async (route): Promise<void> => {
    polls++;
    if (polls === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "unavailable", message: "Call status unavailable." },
        },
      });
    } else {
      await route.continue();
    }
  });
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear and Start New Call" })).toBeVisible();
  await page.waitForTimeout(2200);
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toHaveCount(0);
  expect(polls).toBe(1);
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(
    page.getByRole("region", { name: "Call analysis" }).getByText("Interrupted", { exact: true }),
  ).toBeVisible();
});
