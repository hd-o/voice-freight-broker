import { expect, test } from "./fixtures";
import { sendTranscript, simulateVoice } from "./voice";

test("a simulated multi-load call saves cancellation, replacement, transcript and final counts", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser test origin is required");
  }

  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
  ] as const) {
    expect((await request.post(path, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }

  const errors: string[] = [];
  page.on("pageerror", (error): number => errors.push(error.message));
  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Simulated voice provider.", { exact: false })).toBeVisible();
  await expect(page.getByText("Yes, confirmed.", { exact: true })).toHaveCount(4, { timeout: 15_000 });
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unmute", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Unmute", exact: true }).click();
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await expect(page.getByRole("button", { name: "View this call in dashboard →" })).toBeVisible();
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();
  await expect(page.getByText("Live Call", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Call analysis" }).getByText("Pending", { exact: true })).toBeVisible();
  await expect(page.getByText("Cancelled agreement 1")).toBeVisible();
  await page.getByRole("combobox").click();
  await page.getByRole("option", { name: "NS-seed-v1-02", exact: true }).click();
  await expect(page.getByText("Replaced agreement 1")).toBeVisible();
  await expect(page.getByText("Accepted agreement 2")).toBeVisible();
  await expect(page.getByText("$2,100", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: "Dashboard", exact: true }).click();
  await expect(page.getByText("9 calls in this population")).toBeVisible();

  await expect(
    page
      .locator("dl")
      .filter({ has: page.getByText("Final agreements", { exact: true }) })
      .locator("dd"),
  ).toHaveText("5");

  expect(errors).toEqual([]);
});

test("WebRTC transcripts survive status polls and reconcile with the saved snapshot", async ({
  page,
}): Promise<void> => {
  const scenario = await simulateVoice(page);
  await expect.poll((): number => scenario.polls).toBeGreaterThan(0);
  await page.clock.install();
  const polls = scenario.polls;

  await page.evaluate((): void => {
    for (const detail of [{ type: "session.started" }, { type: "session.input_transcript.delta", delta: 42 }]) {
      window.dispatchEvent(new CustomEvent("voice-message", { detail }));
    }
  });

  await sendTranscript(page, "Live ");
  await sendTranscript(page, "Live ");
  await sendTranscript(page, "greeting.", "second");
  await expect(page.getByText("Live greeting.", { exact: true })).toHaveCount(1);
  expect(scenario.polls).toBe(polls);
  expect(scenario.requests).toBe(0);
  await page.clock.runFor(1100);
  await expect.poll((): number => scenario.polls).toBeGreaterThan(polls);
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  expect(scenario.requests).toBe(0);
  scenario.fragments = [{ id: "voice-test:first", speaker: "broker", startMs: 0, endMs: 500, text: "Saved greeting." }];
  scenario.failures = 1;
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.clock.runFor(1100);
  await expect(page.getByText("Could not load the saved transcript.")).toBeVisible();
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry saved transcript" }).click();
  await expect(page.getByText("Saved greeting.", { exact: true })).toBeVisible();
  await expect(page.getByText("Live greeting.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear and Start New Call" }).click();
  await sendTranscript(page, "Stale greeting.", "stale");
  await expect(page.getByText("Stale greeting.", { exact: true })).toHaveCount(0);
  const requests = scenario.requests;
  await page.clock.runFor(2200);
  expect(scenario.requests).toBe(requests);
});

test("data channel failure polls transcripts without ending audio or losing unsaved text", async ({
  page,
}): Promise<void> => {
  const scenario = await simulateVoice(page);
  await expect.poll((): number => scenario.polls).toBeGreaterThan(0);
  await page.clock.install();
  await sendTranscript(page);
  scenario.failures = 1;

  await page.evaluate((): void => {
    window.dispatchEvent(new Event("voice-close"));
  });

  await expect.poll((): number => scenario.requests).toBe(1);
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeVisible();
  scenario.fragments = [{ id: "voice-test:first", speaker: "broker", startMs: 0, endMs: 500, text: "Live greeting." }];
  await page.clock.runFor(1100);
  await expect.poll((): number => scenario.requests).toBeGreaterThan(1);
  await expect(page.getByText("Live greeting.", { exact: true })).toHaveCount(1);
  // Empty snapshots during persistence lag must not erase received speech.
  scenario.fragments = [];
  await page.clock.runFor(1100);
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Hang up", exact: true }).click();
  await page.clock.runFor(1100);
  await expect(page.getByRole("button", { name: "View this call in dashboard →" })).toBeVisible();
});

test("status failure preserves unsaved WebRTC text until saved-transcript retry", async ({ page }): Promise<void> => {
  const scenario = await simulateVoice(page);
  await expect.poll((): number => scenario.polls).toBeGreaterThan(0);
  await page.clock.install();
  await sendTranscript(page);
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  scenario.statusFailures = 1;
  await page.clock.runFor(1100);
  await expect(page.getByRole("button", { name: "Retry saved transcript" })).toBeVisible();
  await expect(page.getByText("Live greeting.", { exact: true })).toBeVisible();
  expect(scenario.requests).toBe(0);
  await sendTranscript(page, "Ignored after failure.", "late");
  await expect(page.getByText("Ignored after failure.", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Retry saved transcript" }).click();
  await expect(page.getByText("Live greeting.", { exact: true })).toHaveCount(0);
});

test("a data channel that never opens falls back after audio connects", async ({ page }): Promise<void> => {
  const scenario = await simulateVoice(page, false);
  await expect.poll((): number => scenario.polls).toBeGreaterThan(0);
  await page.clock.install();
  scenario.fragments = [{ id: "voice-test:first", speaker: "carrier", startMs: 0, endMs: 500, text: "Saved speech." }];
  expect(scenario.requests).toBe(0);
  await page.clock.runFor(5100);
  await expect(page.getByText("Saved speech.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toBeVisible();
});

test("microphone denial leaves paid startup untouched and allows a retry", async ({ page }): Promise<void> => {
  await page.route("**/api/live/configuration", (route): Promise<void> =>
    route.fulfill({ json: { provider: "openai" } }),
  );

  await page.addInitScript((): void => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: (): Promise<never> => Promise.reject(new DOMException("Microphone denied", "NotAllowedError")),
      },
      configurable: true,
    });
  });

  let paidStarts = 0;

  page.on("request", (request): void => {
    if (new URL(request.url()).pathname === "/api/live/calls") {
      paidStarts++;
    }
  });

  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText("Microphone access blocked", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start call", exact: true })).toBeEnabled();
  expect(paidStarts).toBe(0);
});

test("a status failure ends the call without reviving disposed audio", async ({
  page,
  request,
  baseURL,
}): Promise<void> => {
  if (!baseURL) {
    throw new Error("Browser test origin is required");
  }

  for (const [path, data] of [
    ["/api/session", { userId: "administrator" }],
    ["/api/local/seed", {}],
  ] as const) {
    expect((await request.post(path, { headers: { Origin: baseURL }, data })).ok()).toBe(true);
  }

  let polls = 0;

  await page.route("**/api/calls/*/live", async (route): Promise<void> => {
    polls++;

    if (polls === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: { code: "unavailable", message: "Call status unavailable." },
        },
      });
    } else {
      await route.continue();
    }
  });

  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clear and Start New Call" })).toBeVisible();
  await page.waitForTimeout(2200);
  await expect(page.getByRole("button", { name: "Hang up", exact: true })).toHaveCount(0);
  expect(polls).toBe(1);
  await page.getByRole("button", { name: "View this call in dashboard →" }).click();

  await expect(
    page.getByRole("region", { name: "Call analysis" }).getByText("Interrupted", { exact: true }),
  ).toBeVisible();
});
