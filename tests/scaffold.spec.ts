import { expect, test } from "@playwright/test";

test("static vinext export renders and hydrates under Wrangler", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:4173");
  await expect(
    page.getByRole("heading", { name: "Voice Freight Broker" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check interaction" }).click();
  await expect(
    page.getByRole("button", { name: "Interaction verified" }),
  ).toBeVisible();
});

test("Storybook renders the same interactive scaffold", async ({ page }) => {
  await page.goto(
    "http://127.0.0.1:6006/iframe.html?id=scaffold-placeholder--default&viewMode=story",
  );
  await expect(
    page.getByRole("heading", { name: "Voice Freight Broker" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check interaction" }).click();
  await expect(
    page.getByRole("button", { name: "Interaction verified" }),
  ).toBeVisible();
});
