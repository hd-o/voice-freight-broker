import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openStory(page: Page, story: string, theme = "light") {
  await page.goto(
    `http://127.0.0.1:6006/iframe.html?id=${story}&viewMode=story&globals=theme:${theme}`,
  );
  await expect(page.locator("#storybook-root > *").first()).toBeVisible();
}

test("caller briefing remains accessible on muted surfaces in both themes", async ({
  page,
}) => {
  for (const theme of ["light", "dark"]) {
    await openStory(page, "call-caller-briefing--default", theme);
    await expect(
      page.getByRole("heading", { name: "Your caller briefing" }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page })
      .include("#storybook-root")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations, `${theme} theme`).toEqual([]);
  }
});

test("application navigation supports keyboard access without changing fixtures", async ({
  page,
}) => {
  await openStory(page, "layouts-application--call");
  const call = page.getByRole("button", { name: "Call", exact: true });
  const dashboard = page.getByRole("button", {
    name: "Dashboard",
    exact: true,
  });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to content" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await dashboard.focus();
  await page.keyboard.press("Enter");
  await expect(call).toHaveAttribute("aria-current", "page");
  await expect(dashboard).not.toHaveAttribute("aria-current", "page");
});

test("phone navigation leaves the last content visible and tablet uses a rail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStory(page, "layouts-application--long-content");
  const end = page.getByText("End of content");
  await end.scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const content = await end.boundingBox();
  const navigation = await page.getByRole("navigation").boundingBox();
  expect(content).not.toBeNull();
  expect(navigation).not.toBeNull();
  expect(content!.y + content!.height).toBeLessThan(navigation!.y);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByRole("navigation")).toHaveCSS("width", "64px");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(768);
});

test("load selector supports keyboard options while keeping the selected fixture", async ({
  page,
}) => {
  await openStory(page, "dashboard-loadselector--first-load");
  const selector = page.getByRole("combobox", { name: "Load" });
  await selector.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(selector).toContainText("NS-1042");
  await expect(selector).toBeFocused();
});

test("connected orb stays still with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openStory(page, "call-voice-orb--connected");
  const orb = page.getByRole("img", { name: "Voice connection active" });
  await expect(orb).toBeVisible();
  await expect(orb.locator("img")).toHaveJSProperty("naturalWidth", 280);
  const initial = await orb.screenshot();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let frames = 0;
        function advanceFrame() {
          frames += 1;
          if (frames === 8) resolve();
          else requestAnimationFrame(advanceFrame);
        }
        requestAnimationFrame(advanceFrame);
      }),
  );
  expect(await orb.screenshot()).toEqual(initial);
});

test("connected orb retains its image when WebGL is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // The replacement preserves the canvas receiver through Reflect.apply below.
    // oxlint-disable-next-line typescript/unbound-method
    const getContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      value: function getCanvasContext(
        this: HTMLCanvasElement,
        context: string,
        ...options: unknown[]
      ) {
        return context === "webgl"
          ? null
          : Reflect.apply(getContext, this, [context, ...options]);
      },
    });
  });
  await openStory(page, "call-voice-orb--connected");
  const orb = page.getByRole("img", { name: "Voice connection active" });
  await expect(orb).toBeVisible();
  await expect(orb.locator("img")).toHaveJSProperty("naturalWidth", 280);
  await expect(orb.locator("canvas")).toHaveCSS("opacity", "0");
});

const layouts = [
  { story: "layouts-call--connected", width: 390, height: 844, theme: "light" },
  {
    story: "layouts-dashboard--public-samples",
    width: 768,
    height: 1024,
    theme: "dark",
  },
  {
    story: "layouts-calldetail--default",
    width: 1440,
    height: 1010,
    theme: "light",
  },
];

for (const layout of layouts) {
  test(`${layout.story} is accessible at ${layout.width}px in ${layout.theme} mode`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: layout.width, height: layout.height });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openStory(page, layout.story, layout.theme);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      layout.theme,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(layout.width);
    const results = await new AxeBuilder({ page })
      .include("#storybook-root")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}

test("long dashboard and call details remain within the phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const story of [
    "layouts-dashboard--long-content",
    "layouts-calldetail--long-content",
  ]) {
    await openStory(page, story);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  }
});
