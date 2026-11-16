import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:4173";

test("sign-in failure keeps public samples available", async ({ page }): Promise<void> => {
  await page.goto(`${origin}/call`);
  await page.getByRole("button", { name: "Sign in to start a call" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Local sign in" });
  await expect(dialog.getByRole("alert")).toContainText("Service unavailable");
  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("link", { name: "Explore sample calls" }).click();
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
});

test.beforeEach(async ({ page }): Promise<void> => {
  await page.route("**/api{,/**}", (route): Promise<void> => route.abort("connectionrefused"));
});

test("public static routes load directly and navigation works without an API", async ({ page }): Promise<void> => {
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error): number => errors.push(error.message));

  page.on("request", (request): void => {
    if (new URL(request.url()).pathname.startsWith("/api")) {
      requests.push(request.url());
    }
  });

  await page.goto(`${origin}/call`);
  await expect(page.getByRole("heading", { name: "Voice Call Demo" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCSS("position", "fixed");
  await expect(page.getByText("MC 123456")).toBeVisible();
  await page.getByRole("link", { name: "Explore sample calls" }).click();
  await expect(page).toHaveURL(`${origin}/dashboard`);
  await expect(page.getByRole("heading", { name: "Call Dashboard" })).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("link", { name: "Call", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/call`);
  await page.goto(`${origin}/dashboard`);
  await expect(page.getByRole("heading", { name: "Call Dashboard" })).toBeVisible();
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Voice Call Demo" })).toBeVisible();
  expect(errors).toEqual([]);
  expect(requests).toEqual([]);
});

test("whole history rows open a dedicated details page with load and navigation history", async ({
  page,
}): Promise<void> => {
  await page.goto(`${origin}/dashboard`);
  const metrics = page.getByLabel("Call metrics");
  await expect(metrics.getByText("60%", { exact: true })).toBeVisible();
  await expect(metrics.getByText("3 of 5 matched calls")).toBeVisible();
  await expect(metrics.getByText("+$95", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();

  const row = page.getByRole("row").filter({
    has: page.getByRole("link", {
      name: "View call from Summit Transport",
      exact: false,
    }),
  });

  const carrierCell = row.getByRole("cell", {
    name: "Summit Transport",
    exact: true,
  });

  await carrierCell.scrollIntoViewIfNeeded();
  const carrier = await carrierCell.boundingBox();

  if (!carrier) {
    throw new Error("The carrier cell must be visible");
  }

  await page.mouse.click(carrier.x + carrier.width / 2, carrier.y + carrier.height / 2);
  await expect(page).toHaveURL(`${origin}/dashboard/call?call=summit-1042`);
  await expect(page.getByRole("heading", { name: "Call Dashboard" })).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(page.getByLabel("Call metrics")).toHaveCount(0);

  const details = page.getByRole("region", {
    name: "Call details",
    exact: true,
  });

  await expect(details.getByText("Sample Call", { exact: true })).toBeVisible();
  await expect(details.getByRole("heading", { name: "Dallas → Atlanta" })).toBeVisible();
  await expect(details.getByText("$150 above posted rate")).toBeVisible();
  await details.getByRole("combobox", { name: "Load", exact: true }).click();
  await page.getByRole("option", { name: "NS-1048" }).click();
  await expect(details.getByRole("heading", { name: "Memphis → Denver" })).toBeVisible();
  await expect(details.getByText("$2,950", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveURL(`${origin}/dashboard/call?call=summit-1042&load=NS-1048`);
  await page.reload();
  await expect(details.getByRole("heading", { name: "Memphis → Denver" })).toBeVisible();
  await page.goBack();
  await expect(details.getByRole("heading", { name: "Dallas → Atlanta" })).toBeVisible();
  await page.goForward();
  await expect(details.getByRole("heading", { name: "Memphis → Denver" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(page).toHaveURL(`${origin}/dashboard`);
  await expect(details).toHaveCount(0);
  await page.goBack();
  await expect(details.getByRole("heading", { name: "Memphis → Denver" })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("table")).toBeVisible();

  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Showing 6–8 of 8 calls")).toBeVisible();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();

  const status = row.getByRole("cell", { name: "Complete", exact: true });
  await status.scrollIntoViewIfNeeded();
  const statusCell = await status.boundingBox();

  if (!statusCell) {
    throw new Error("The analysis cell must be visible");
  }

  await page.mouse.click(statusCell.x + statusCell.width - 4, statusCell.y + statusCell.height - 4);
  await expect(page).toHaveURL(`${origin}/dashboard/call?call=retained&page=2`);
  await expect(details.getByRole("heading", { name: "Phoenix → Dallas" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(page).toHaveURL(`${origin}/dashboard?page=2`);
  await expect(page.getByText("Showing 6–8 of 8 calls")).toBeVisible();

  const link = page.getByRole("link", {
    name: "View call from Summit Transport",
    exact: false,
  });

  await link.focus();
  await link.press("Enter");
  await expect(page).toHaveURL(`${origin}/dashboard/call?call=retained&page=2`);
  await page.goBack();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
});

test("call details show loading until the browser reads the selected call", async ({ page }): Promise<void> => {
  let releaseScripts = (): void => {};

  const scripts = new Promise<void>((resolve): void => {
    releaseScripts = resolve;
  });

  await page.route("**/*", async (route): Promise<void> => {
    if (route.request().resourceType() !== "script") {
      await route.fallback();
      return;
    }

    await scripts;
    await route.continue();
  });

  try {
    await page.goto(`${origin}/dashboard/call?call=summit-1042`, {
      waitUntil: "commit",
    });

    await expect(page.getByRole("status", { name: "Loading call details" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "No call selected" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Call unavailable" })).toHaveCount(0);
  } finally {
    releaseScripts();
  }

  await expect(page.getByRole("heading", { name: "Dallas → Atlanta" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading call details" })).toHaveCount(0);
  await page.goto(`${origin}/dashboard/call`);
  await expect(page.getByRole("heading", { name: "No call selected" })).toBeVisible();
});

test("pending and missing sample data keep statuses and useful recovery visible", async ({ page }): Promise<void> => {
  await page.goto(`${origin}/dashboard/call?call=mesa`);

  const details = page.getByRole("region", {
    name: "Call details",
    exact: true,
  });

  const analysis = details.getByRole("region", { name: "Call analysis" });
  await expect(analysis.getByText("Connection", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Interrupted", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Analysis", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Pending", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Sentiment", { exact: true })).toBeVisible();
  await expect(analysis.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(details.getByText("Partial transcript", { exact: false })).toBeVisible();

  await page.goto(`${origin}/dashboard/call?call=connection&page=2`);
  await expect(details.getByRole("heading", { name: "Unknown carrier" })).toBeVisible();
  await expect(details.getByText("Connection failed", { exact: true })).toBeVisible();
  await expect(details.getByText("No transcript was recorded for this call.")).toBeVisible();
  await expect(details.getByRole("combobox")).toBeDisabled();

  await page.goto(`${origin}/dashboard/call?call=missing`);
  await expect(details.getByRole("heading", { name: "Call unavailable" })).toBeVisible();
  await page.getByRole("link", { name: "Back to dashboard" }).click();
  await expect(details).toHaveCount(0);

  await page.goto(`${origin}/dashboard/call?call=summit-1042&load=missing`);
  await expect(details.getByRole("heading", { name: "Load unavailable" })).toBeVisible();
  await details.getByRole("combobox").click();
  await page.getByRole("option", { name: "NS-1042" }).click();
  await expect(details.getByRole("heading", { name: "Dallas → Atlanta" })).toBeVisible();
});
