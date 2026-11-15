import { expect, test } from "@playwright/test";

test("navigation tooltips support hover, keyboard focus, and Escape", async ({ page }): Promise<void> => {
  await page.goto("http://127.0.0.1:6006/iframe.html?id=navigation-navigation--call&viewMode=story");

  const call = page.getByRole("link", { name: "Call", exact: true });

  const dashboard = page.getByRole("link", {
    name: "Dashboard",
    exact: true,
  });

  await call.hover();
  const tooltip = page.locator("[data-slot='tooltip-content']");
  await expect(tooltip).toHaveText("Call");
  await expect(call).not.toHaveAttribute("title");

  const triggerBounds = await call.boundingBox();
  const tooltipBounds = await tooltip.boundingBox();

  if (!triggerBounds || !tooltipBounds) {
    throw new Error("Tooltip and trigger must be visible");
  }

  expect(tooltipBounds.x).toBeGreaterThan(triggerBounds.x + triggerBounds.width);

  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
  await page.mouse.move(400, 200);
  await call.focus();
  await page.keyboard.press("Tab");
  await expect(dashboard).toBeFocused();
  await expect(tooltip).toHaveText("Dashboard");
  await page.keyboard.press("Escape");
  await expect(tooltip).not.toBeVisible();
  await expect(dashboard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(call).toHaveAttribute("aria-current", "page");
});

test("account tooltips match session labels and stay inside the phone viewport", async ({ page }): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 });

  for (const fixture of [
    { story: "call", label: "Sign in", theme: "light" },
    { story: "dashboard", label: "Sign out", theme: "dark" },
  ]) {
    await page.goto(
      `http://127.0.0.1:6006/iframe.html?id=navigation-navigation--${fixture.story}&viewMode=story&globals=theme:${fixture.theme}`,
    );

    const account = page.getByRole("button", {
      name: fixture.label,
      exact: true,
    });

    await account.hover();
    const tooltip = page.getByText(fixture.label, { exact: true });
    await expect(tooltip).toHaveText(fixture.label);
    await expect(account).not.toHaveAttribute("title");

    const bounds = await tooltip.boundingBox();

    if (!bounds) {
      throw new Error("Tooltip must be visible");
    }

    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);

    await account.click();
    await expect(tooltip).not.toBeVisible();
    await expect(account).toHaveAccessibleName(fixture.label);
  }
});
