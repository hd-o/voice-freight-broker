import { expect, test } from "./fixtures";

test.use({ voiceScenario: "budget-active" });
test("ends a connected call with a clear allowance message", async ({ page, request, baseURL }): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser test origin is required");
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
  await expect(
    page.getByText("The shared spending allowance or call work limit was reached.", { exact: false }),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "View this call in dashboard →" })).toBeVisible();
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(page.getByText("Live Call", { exact: true })).toBeVisible();
  await expect(page.getByText("No transcript was recorded for this call.")).toBeVisible();
});
