import { test, expect } from "./fixtures";

test.use({ voiceScenario: "analysis-failure" });

test("failed queued analysis stays visible and an administrator retries the same saved call", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  test.setTimeout(120_000);
  if (!baseURL) {
    throw new Error("Browser origin required");
  }

  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
  ] as const) {
    expect((await request.post(path, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }

  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Yes, confirmed.", { exact: true })).toHaveCount(4, { timeout: 15_000 });
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByRole("link", { name: "View this call in dashboard →" }).click();
  await expect(page).toHaveURL(/\/dashboard\/call\?call=/);
  const url = page.url();
  const analysis = page.getByRole("region", { name: "Call analysis" });
  await expect(analysis.getByText("Pending", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Failed", { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole("button", { name: "Retry analysis", exact: true })).toHaveCount(0);
  await expect(page.getByText("Cancelled agreement 1")).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Administrator", exact: true }).click();
  await page.getByRole("button", { name: "Retry analysis", exact: true }).click();
  await expect(analysis.getByText("Complete", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(analysis).toContainText("1 final simulated agreement");
  await expect(page.getByText("Cancelled agreement 1")).toBeVisible();
  expect(page.url()).toBe(url);
});
