import { expect, test } from "@playwright/test";

test.use({
  launchOptions: { ignoreDefaultArgs: ["--disable-back-forward-cache"] },
});

test("reloading call details and traversing history preserves the selected call", async ({
  page,
}, testInfo) => {
  const session =
    testInfo.project.name === "development"
      ? await page.context().newCDPSession(page)
      : null;

  if (session) {
    test.slow();
    // Keep HTTP caching enabled while exposing stylesheet/module request races.
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 200,
      downloadThroughput: 1_500_000,
      uploadThroughput: 1_500_000,
    });
  }

  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api"))
      requests.push(request.url());
  });

  for (const navigation of ["history", "return", "rail"] as const) {
    await page.goto("/dashboard?page=2");
    const link = page.getByRole("link", {
      name: "View call from Summit Transport",
      exact: false,
    });
    await expect(link).toBeVisible({ timeout: 15_000 });
    await link.click();
    await expect(
      page.getByRole("heading", { name: "Phoenix → Dallas" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Phoenix → Dallas" }),
    ).toBeVisible();

    if (navigation === "history") {
      // A document restored from BFCache does not fire another load event.
      await page.goBack({ waitUntil: "commit" });
    } else if (navigation === "return") {
      await page.getByRole("button", { name: "Back to dashboard" }).click();
    } else {
      await page.getByRole("link", { name: "Dashboard", exact: true }).click();
    }

    await expect(page).toHaveURL(/\/dashboard\?page=2$/);
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.getByText("Showing 6–8 of 8 sample calls")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Call", exact: true }),
    ).toBeVisible();

    if (navigation === "history") {
      await page.goForward({ waitUntil: "commit" });
    } else {
      await link.click();
    }

    await expect(page).toHaveURL(/\/dashboard\/call\?call=retained&page=2$/);
    await expect(
      page.getByRole("heading", { name: "Phoenix → Dallas" }),
    ).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    expect(errors, `${navigation} navigation`).toEqual([]);
    expect(requests, `${navigation} API requests`).toEqual([]);

    if (session && navigation === "history") {
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
    }
  }
});
