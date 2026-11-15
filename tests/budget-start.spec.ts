import { expect, test } from "./fixtures";

test.use({ voiceScenario: "budget-start" });
test("explains renewal without creating a call", async ({ page }): Promise<void> => {
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();

  await expect(
    page.getByText("The shared $25 monthly allowance cannot cover another call.", { exact: false }),
  ).toBeVisible();

  await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
});
