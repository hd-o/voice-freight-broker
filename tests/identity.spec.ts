import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.use({
  launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
});

async function signIn(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("alertdialog", { name: "Local sign in" }).getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
}

async function createReviewerCall(request: APIRequestContext, baseURL?: string): Promise<{ id: string }> {
  if (!baseURL) {
    throw new Error("Browser test server must have a URL");
  }

  const headers = { Origin: baseURL };

  for (const [url, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
    ["/api/session", { userId: "reviewer" }],
  ] as const) {
    const response = await request.post(url, { headers, data });
    expect(response.ok()).toBe(true);
  }

  const response = await request.post("/api/calls", { headers, data: {} });
  expect(response.status()).toBe(201);
  const record: { id: string } = await response.json();

  const ended = await request.post(`/api/calls/${record.id}/end`, {
    headers,
    data: { connection: "Ended normally", transcriptComplete: true },
  });

  expect(ended.ok()).toBe(true);

  return record;
}

test("keeps the account sidebar mounted when navigating between pages", async ({ page }): Promise<void> => {
  let identityRequests = 0;
  await page.addInitScript((): void => localStorage.setItem("freight-local-session", "test-session"));
  await page.route("**/api/identity", async (route): Promise<void> => {
    identityRequests++;
    await route.fulfill({
      json: { user: { id: "reviewer", name: "Local Reviewer", role: "reviewer" }, identities: [] },
    });
  });
  await page.route(
    (url): boolean => url.pathname === "/api/dashboard",
    async (route): Promise<void> => {
      await route.fulfill({ json: { calls: [] } });
    },
  );
  await page.goto("/call");
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer" })).toBeVisible();
  await page.getByRole("navigation", { name: "Main navigation" }).evaluate((navigation): void => {
    navigation.setAttribute("data-test-instance", "original");
  });
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Call Dashboard" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveAttribute(
    "data-test-instance",
    "original",
  );
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
  expect(identityRequests).toBe(1);
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Voice Call Demo" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toHaveAttribute(
    "data-test-instance",
    "original",
  );
});

test("private history stays scoped across logout and browser history", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  const record = await createReviewerCall(request, baseURL);

  const errors: string[] = [];
  page.on("pageerror", (error): number => errors.push(error.message));
  await page.goto("/dashboard");
  await signIn(page, "Local Reviewer");
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restock inventory" })).toHaveCount(0);
  await expect(page.getByText("9 calls in this population")).toBeVisible();
  await page.locator(`a[href*="${record.id}"]`).click();
  await expect(page.getByText("Live Call", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Live Call", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Sign in to view this private call.")).toBeVisible();
  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
  await page.goForward({ waitUntil: "commit" });
  await expect(page.getByText("Sign in to view this private call.")).toBeVisible();
  await signIn(page, "Second Reviewer");
  await expect(page.getByRole("heading", { name: "Call unavailable" })).toBeVisible();
  await expect(page.getByText("Live Call", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("administrator access is cleared after logout in another tab", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  const record = await createReviewerCall(request, baseURL);
  await page.goto("/dashboard");
  await signIn(page, "Local Administrator");
  await expect(page.locator(`a[href*="${record.id}"]`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Restock inventory" })).toBeVisible();

  const otherTab = await page.context().newPage();
  await otherTab.goto("/dashboard");
  await otherTab.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Restock inventory" })).toHaveCount(0);
  await otherTab.close();
});

test("logout blocks overlapping account changes in this tab and another tab", async ({
  page,
  context,
}): Promise<void> => {
  await page.goto("/dashboard");
  await signIn(page, "Local Administrator");

  const record = await page.evaluate(async (): Promise<{ id: string }> => {
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
  await expect(otherTab.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();

  let releaseLogout = (): void => {};

  const logoutGate = new Promise<void>((resolve): void => {
    releaseLogout = resolve;
  });

  await page.route("**/api/session", async (route): Promise<void> => {
    if (route.request().method() === "DELETE") {
      await logoutGate;
    }

    await route.continue();
  });

  const signIns: string[] = [];

  context.on("request", (request): void => {
    if (request.url().endsWith("/api/session") && request.method() === "POST") {
      signIns.push(request.url());
    }
  });

  try {
    const logout = page.waitForRequest(
      (request): boolean => request.url().endsWith("/api/session") && request.method() === "DELETE",
    );

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout;
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await expect(page.locator(`a[href*="${record.id}"]`)).toHaveCount(0);
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();

    await otherTab.getByRole("button", { name: "Sign in to start a call" }).click();
    const dialog = otherTab.getByRole("alertdialog", { name: "Local sign in" });

    const reviewer = dialog.getByRole("button", {
      name: "Local Reviewer",
      exact: true,
    });

    await reviewer.click();
    await expect(dialog.getByRole("status")).toContainText("Another account change is finishing");
    await expect(reviewer).toBeDisabled();

    await expect(
      otherTab.getByRole("button", {
        name: "Sign in to start a call",
        includeHidden: true,
      }),
    ).toBeDisabled();

    expect(signIns).toHaveLength(0);

    releaseLogout();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(reviewer).toBeEnabled();
    await expect(dialog).toBeVisible();
    expect(signIns).toHaveLength(0);
    await reviewer.click();
    await expect(dialog).toHaveCount(0);
    expect(signIns).toHaveLength(1);
    await otherTab.goto("/dashboard");

    await expect(
      otherTab.getByRole("img", {
        name: "Signed in as Local Reviewer",
        exact: true,
      }),
    ).toBeVisible();

    await otherTab.reload();

    await expect(
      otherTab.getByRole("img", {
        name: "Signed in as Local Reviewer",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    releaseLogout();
    await otherTab.close();
  }
});

test("failed logout releases account controls and leaves public samples usable", async ({ page }): Promise<void> => {
  await page.goto("/dashboard");
  await signIn(page, "Local Administrator");
  let releaseLogout = (): void => {};

  const logoutGate = new Promise<void>((resolve): void => {
    releaseLogout = resolve;
  });

  await page.route("**/api/session", async (route): Promise<void> => {
    if (route.request().method() !== "DELETE") {
      return route.continue();
    }

    await logoutGate;
    await route.fulfill({ status: 503, body: "{}" });
  });

  try {
    const logout = page.waitForRequest(
      (request): boolean => request.url().endsWith("/api/session") && request.method() === "DELETE",
    );

    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await logout;
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
    releaseLogout();

    await expect(
      page.getByText("Private data cleared. Server sign-out failed", {
        exact: false,
      }),
    ).toBeVisible();

    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Restock inventory" })).toHaveCount(0);
    await expect(page.getByText("Showing 1–5 of 8 calls")).toBeVisible();
    await page.unroute("**/api/session");
    await signIn(page, "Local Reviewer");
    await page.reload();

    await expect(
      page.getByRole("img", {
        name: "Signed in as Local Reviewer",
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    releaseLogout();
  }
});
