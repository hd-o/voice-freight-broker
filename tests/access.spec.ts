import { expect, test } from "./fixtures";

// The edge login challenge is simulated here; JWT verification is covered by
// Cloudflare/D1 integration tests. Business tools and stub voice remain real.
test.beforeEach(async ({ page, baseURL }): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser origin is required.");
  }

  await page.route("**/auth/configuration", (route): Promise<void> => route.fulfill({ json: { mode: "access" } }));
  await page.route("**/auth/identity", async (route): Promise<void> => {
    const identity = await page.request.get(`${baseURL}/api/identity`);
    await route.fulfill({ json: await identity.json() });
  });
  await page.route("**/api/login?*", async (route): Promise<void> => {
    const response = await page.request.post(`${baseURL}/api/session`, {
      headers: { Origin: baseURL },
      data: { userId: "reviewer" },
    });
    expect(response.ok()).toBe(true);
    const destination = new URL(route.request().url()).searchParams.get("returnTo") ?? "/call";
    const callback = new URL(destination, baseURL);
    callback.searchParams.set("account", "signed-in");
    await route.fulfill({ status: 303, headers: { Location: callback.href } });
  });
  await page.route("**/cdn-cgi/access/logout?*", (route): Promise<void> =>
    route.fulfill({ status: 303, headers: { Location: "/call" } }),
  );
});

test("deployed login returns to the selected page, reload restores identity, and logout clears it", async ({
  page,
}): Promise<void> => {
  await page.goto("/dashboard?page=2");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\?page=2$/);
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restock inventory" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/call$/);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer" })).toHaveCount(0);
});

test("deployed account controls complete a stubbed multi-agreement call and recover from expiry", async ({
  page,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser origin is required.");
  }

  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
    ["/api/session", { userId: "reviewer" }],
  ] as const) {
    expect((await page.request.post(`${baseURL}${path}`, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }

  await page.goto("/call");
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Yes, confirmed.", { exact: true })).toHaveCount(4, { timeout: 15_000 });
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.getByRole("link", { name: "View this call in dashboard →" }).click();
  await expect(page.getByRole("region", { name: "Call analysis" }).getByText("Complete", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("Cancelled agreement 1")).toBeVisible();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "NS-seed-v1-02", exact: true }).click();
  await expect(page.getByText("Replaced agreement 1")).toBeVisible();
  await expect(page.getByText("Accepted agreement 2")).toBeVisible();
  await page.route("**/api/calls/*", (route): Promise<void> =>
    route.fulfill({ status: 401, json: { error: { code: "unauthenticated", message: "Session expired." } } }),
  );
  await page.request.delete(`${baseURL}/api/session`, { headers: { Origin: baseURL } });
  await page.evaluate((): void => {
    window.dispatchEvent(new Event("freight-session-expired"));
  });
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByText("Session expired. Sign in again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Call unavailable", exact: true })).toBeVisible();
  await expect(page.getByText("Accepted agreement 2")).toHaveCount(0);
});

test("deployed logout clears another tab before a delayed revocation completes", async ({
  page,
  context,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser origin is required.");
  }

  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  const other = await context.newPage();
  let signedIn = true;
  await other.route("**/auth/configuration", (route): Promise<void> => route.fulfill({ json: { mode: "access" } }));
  await other.route("**/auth/identity", (route): Promise<void> =>
    route.fulfill({ json: { user: signedIn ? { id: "reviewer", name: "Local Reviewer", role: "reviewer" } : null } }),
  );
  await other.route("**/api/dashboard", (route): Promise<void> => route.fulfill({ json: { calls: [] } }));
  await other.goto(`${baseURL}/dashboard`);
  await expect(other.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  let release: () => void = (): void => {};
  const revocation = new Promise<void>((resolve): void => {
    release = resolve;
  });
  await page.route("**/api/session", async (route): Promise<void> => {
    await revocation;
    signedIn = false;
    await route.continue();
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(other.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await other.evaluate((): void => {
    window.dispatchEvent(new Event("focus"));
  });
  await expect(other.getByRole("img", { name: "Signed in as Local Reviewer" })).toHaveCount(0);
  await other.reload();
  await expect(other.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await expect(page.getByRole("img", { name: "Signed in as Local Reviewer" })).toHaveCount(0);
  release();
  await expect(page).toHaveURL(/\/call$/);
  await expect(other.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  await other.close();
});

test("deployed logout clears Access after a lost revocation response and permits sign-in", async ({
  page,
}): Promise<void> => {
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
  let cleanup = false;
  await page.route("**/cdn-cgi/access/logout?*", async (route): Promise<void> => {
    cleanup = true;
    await route.fulfill({ status: 303, headers: { Location: "/call" } });
  });
  await page.route("**/api/session", async (route): Promise<void> => {
    if (route.request().method() === "DELETE") {
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    } else {
      await route.continue();
    }
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();
  expect(cleanup).toBe(true);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeEnabled();
});
