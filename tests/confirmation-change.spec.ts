import { test, expect } from "./fixtures";

test.use({ voiceScenario: "confirmation-change" });

test("does not save a conditional acceptance and returns to negotiation", async ({
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
    "get a new quote before confirmation",
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(page.getByText("Accepted agreement 1")).toHaveCount(0);
});
