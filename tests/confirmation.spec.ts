import { test, expect } from "./fixtures";

test.use({ voiceScenario: "confirmation-failure" });

test("preserves saved agreements when cancellation and replacement cannot be checked", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
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
  await expect(page.getByRole("region", { name: "Transcript", exact: true })).toContainText(
    "Your existing agreements are preserved",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(page.getByText("Accepted agreement 1")).toBeVisible();
  await expect(page.getByText("Cancelled agreement 1")).toHaveCount(0);
  await expect(page.getByText("Replaced agreement 1")).toHaveCount(0);
});
