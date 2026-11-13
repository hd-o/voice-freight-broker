import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

test.use({
  launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
});

async function signIn(page: Page, name: string) {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Local sign in" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();
}

test("local identities scope private history, restocking, logout, and expired sessions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/dashboard");
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);

  const record = await page.evaluate(async () => {
    const headers = { "Content-Type": "application/json" };
    await fetch("/api/session", { method: "DELETE", headers });
    await fetch("/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "administrator" }),
    });
    await fetch("/api/local/seed", { method: "POST", headers });
    await fetch("/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "reviewer" }),
    });
    const response = await fetch("/api/calls", {
      method: "POST",
      headers,
      body: "{}",
    });
    const call: { id: string } = await response.json();
    await fetch(`/api/calls/${call.id}/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        connection: "Ended normally",
        transcriptComplete: true,
      }),
    });
    const dashboard: { calls: unknown[] } = await (
      await fetch("/api/dashboard")
    ).json();
    await fetch("/api/session", { method: "DELETE", headers });
    return { ...call, count: dashboard.calls.length };
  });

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Local sign in" });
  await expect(
    dialog.getByRole("button", { name: "Local Reviewer", exact: true }),
  ).toBeEnabled();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await dialog
    .getByRole("button", { name: "Local Reviewer", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText("Local Reviewer · Reviewer", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restock inventory" }),
  ).toHaveCount(0);
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await expect(
    page.getByText(`${8 + record.count} calls in this population`),
  ).toBeVisible();
  await expect(page.locator(`a[href*="${record.id}"]`)).toBeVisible();
  await page.goto(`/dashboard?page=${Math.floor(record.count / 5) + 1}`);
  await expect(
    page.getByRole("link", { name: "View call from Summit Transport" }),
  ).toBeVisible();
  await page.goto("/dashboard");

  await page.route("**/api/dashboard", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.reload();
  await expect(
    page.getByText("Local API unavailable", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
  await page.unroute("**/api/dashboard");
  await page.reload();

  await page.locator(`a[href*="${record.id}"]`).click();
  await expect(page.getByText("Live Call", { exact: true })).toBeVisible();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Live Call", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Sign in to view this private call."),
  ).toBeVisible();
  await page.goBack({ waitUntil: "commit" });
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
  await page.goForward({ waitUntil: "commit" });
  await expect(
    page.getByText("Sign in to view this private call."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Second Reviewer", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Call unavailable" }),
  ).toBeVisible();
  await expect(page.getByText("Live Call", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Back to dashboard" }).click();
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Local Administrator", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restock inventory" }),
  ).toBeVisible();
  await expect(page.locator(`a[href*="${record.id}"]`)).toBeVisible();
  await page.getByRole("button", { name: "Restock inventory" }).click();
  await expect(page.getByRole("status")).toContainText("Added 20 loads");
  await page.route("**/api/inventory/restock", (route) =>
    route.fulfill({ status: 503, body: "{}" }),
  );
  await page.getByRole("button", { name: "Restock inventory" }).click();
  await expect(page.getByRole("alert")).toContainText("Local API unavailable");
  await page.unroute("**/api/inventory/restock");

  const otherTab = await page.context().newPage();
  await otherTab.goto("/dashboard");
  await expect(
    otherTab.getByRole("button", { name: "Restock inventory" }),
  ).toBeVisible();
  await otherTab.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Restock inventory" }),
  ).toHaveCount(0);
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await otherTab.close();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Local Administrator", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Restock inventory" }),
  ).toBeVisible();

  await page.context().clearCookies();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Restock inventory" }),
  ).toHaveCount(0);
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
  expect(errors).toEqual([]);
});

test("logout blocks overlapping account changes in this tab and another tab", async ({
  page,
  context,
}) => {
  await page.goto("/dashboard");
  await signIn(page, "Local Administrator");
  const record = await page.evaluate(async () => {
    const headers = { "Content-Type": "application/json" };
    await fetch("/api/local/seed", { method: "POST", headers });
    const response = await fetch("/api/calls", {
      method: "POST",
      headers,
      body: "{}",
    });
    const call: { id: string } = await response.json();
    await fetch(`/api/calls/${call.id}/end`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        connection: "Ended normally",
        transcriptComplete: true,
      }),
    });
    return call;
  });
  await page.reload();
  await expect(page.locator(`a[href*="${record.id}"]`)).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto("/call");
  await expect(
    otherTab.getByRole("button", { name: "Sign out", exact: true }),
  ).toBeEnabled();

  let releaseLogout = () => {};
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "DELETE") await logoutGate;
    await route.continue();
  });
  const signIns: string[] = [];
  context.on("request", (request) => {
    if (request.url().endsWith("/api/session") && request.method() === "POST")
      signIns.push(request.url());
  });
  try {
    const logout = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/session") && request.method() === "DELETE",
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout;
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();

    await otherTab
      .getByRole("button", { name: "Sign in to start a call" })
      .click();
    const dialog = otherTab.getByRole("dialog", { name: "Local sign in" });
    const reviewer = dialog.getByRole("button", {
      name: "Local Reviewer",
      exact: true,
    });
    await reviewer.click();
    await expect(dialog.getByRole("status")).toContainText(
      "Another account change is finishing",
    );
    await expect(reviewer).toBeDisabled();
    await expect(
      otherTab.getByRole("button", { name: "Sign in to start a call" }),
    ).toBeDisabled();
    expect(signIns).toHaveLength(0);

    releaseLogout();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await expect(reviewer).toBeEnabled();
    await expect(dialog).toBeVisible();
    expect(signIns).toHaveLength(0);
    await reviewer.click();
    await expect(dialog).toHaveCount(0);
    expect(signIns).toHaveLength(1);
    await otherTab.goto("/dashboard");
    await expect(
      otherTab.getByText("Local Reviewer · Reviewer", { exact: true }),
    ).toBeVisible();
    await otherTab.reload();
    await expect(
      otherTab.getByText("Local Reviewer · Reviewer", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseLogout();
    await otherTab.close();
  }
});

test("failed logout releases account controls and leaves public samples usable", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await signIn(page, "Local Administrator");
  let releaseLogout = () => {};
  const logoutGate = new Promise<void>((resolve) => {
    releaseLogout = resolve;
  });
  await page.route("**/api/session", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    await logoutGate;
    await route.fulfill({ status: 503, body: "{}" });
  });
  try {
    const logout = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/session") && request.method() === "DELETE",
    );
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout;
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
    releaseLogout();
    await expect(
      page.getByText("Private data cleared. Server sign-out failed", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "Restock inventory" }),
    ).toHaveCount(0);
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
    await page.unroute("**/api/session");
    await signIn(page, "Local Reviewer");
    await page.reload();
    await expect(
      page.getByText("Local Reviewer · Reviewer", { exact: true }),
    ).toBeVisible();
  } finally {
    releaseLogout();
  }
});
