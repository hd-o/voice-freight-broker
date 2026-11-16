import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { completeCall } from "@voice-freight/backend/calls";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { resetDailyQuotas } from "@voice-freight/backend/quotas";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";
import {
  calculateAvailableMicrodollars,
  chargeUsage,
  monthlyLimitMicrodollars,
  usageLimits,
} from "@voice-freight/backend/spending";

const clock = "2026-11-16T12:00:00.000Z";
const local = { ENVIRONMENT: "local", AUTH_MODE: "local" };
const limits = { ...usageLimits, reviewerDailyCalls: 1, globalDailyCalls: 2 };

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

async function finishCall(id: string, userId: string): Promise<void> {
  await transact(env.DB, (state): void => {
    const session = state.liveSessions.find((entry): boolean => entry.id === id)!;
    session.state = "ended";
    state.reservations.find((entry): boolean => entry.id === id)!.settled = true;
    completeCall(state, { callId: id, userId }, { connection: "Ended normally", transcriptComplete: true }, clock);
  });
}

it("resets all local daily quotas while preserving call history, spending and reservations", async (): Promise<void> => {
  const first = await reserveLiveCall(env.DB, "reviewer", "first", clock, limits, "local");
  await finishCall(first.id, "reviewer");
  await expect(reserveLiveCall(env.DB, "reviewer", "blocked", clock, limits, "local")).rejects.toMatchObject({
    code: "daily_limit",
  });
  const second = await reserveLiveCall(env.DB, "reviewer-two", "second", clock, limits, "local");
  await finishCall(second.id, "reviewer-two");
  await transact(env.DB, (state): void => {
    chargeUsage(state, first.id, "saved-usage", "2026-11", 500);
    state.reservations.push({
      ...state.reservations[0],
      id: "uncertain",
      operationId: "uncertain",
      kind: "confirmation",
      settled: false,
      reservedMicrodollars: 1000,
      chargedMicrodollars: 0,
    });
  });
  await expect(
    reserveLiveCall(env.DB, "administrator", "global-blocked", clock, limits, "local"),
  ).rejects.toMatchObject({ code: "daily_limit" });
  const before = (await readState(env.DB)).state;
  expect(await resetDailyQuotas(env.DB, "administrator", local, clock)).toEqual({
    scope: "daily_calls",
    resetAt: clock,
  });
  const after = (await readState(env.DB)).state;
  expect({ ...after, quotaResets: before.quotaResets }).toEqual(before);
  expect(calculateAvailableMicrodollars(after, clock)).toBe(calculateAvailableMicrodollars(before, clock));

  // The same millisecond is intentional: quota generations follow transaction
  // order, so new calls count immediately even when clock precision is shared.
  const third = await reserveLiveCall(env.DB, "reviewer", "third", clock, limits, "local");
  await finishCall(third.id, "reviewer");
  await expect(reserveLiveCall(env.DB, "reviewer", "blocked-again", clock, limits, "local")).rejects.toMatchObject({
    code: "daily_limit",
  });
  const fourth = await reserveLiveCall(env.DB, "reviewer-two", "fourth", clock, limits, "local");
  await finishCall(fourth.id, "reviewer-two");
  await expect(
    reserveLiveCall(env.DB, "administrator", "global-blocked-again", clock, limits, "local"),
  ).rejects.toMatchObject({ code: "daily_limit" });
  expect(await reserveLiveCall(env.DB, "reviewer", "first", clock, limits, "local")).toEqual(first);
});

it("keeps active-call concurrency and uncertain termination checks after reset", async (): Promise<void> => {
  const call = await reserveLiveCall(env.DB, "reviewer", "active", clock, limits, "local");
  await resetDailyQuotas(env.DB, "administrator", local, clock);
  await expect(reserveLiveCall(env.DB, "reviewer", "overlap", clock, limits, "local")).rejects.toMatchObject({
    code: "concurrent_limit",
  });
  await transact(env.DB, (state): void => {
    const session = state.liveSessions.find((entry): boolean => entry.id === call.id)!;
    session.state = "ended";
    session.providerAttempted = true;
    session.providerClosed = false;
  });
  await resetDailyQuotas(env.DB, "administrator", local, clock);
  await expect(reserveLiveCall(env.DB, "reviewer", "uncertain", clock, limits, "local")).rejects.toMatchObject({
    code: "concurrent_limit",
  });
});

it("preserves the monthly budget guard and hosted daily call accounting", async (): Promise<void> => {
  const call = await reserveLiveCall(env.DB, "reviewer", "old", clock, limits, "local");
  await finishCall(call.id, "reviewer");
  await resetDailyQuotas(env.DB, "administrator", local, clock);
  await expect(reserveLiveCall(env.DB, "reviewer", "hosted", clock, limits, "hosted")).rejects.toMatchObject({
    code: "daily_limit",
  });
  await transact(env.DB, (state): void => {
    state.spendingPeriods.push({ id: "2026-11", spentMicrodollars: monthlyLimitMicrodollars });
  });
  await resetDailyQuotas(env.DB, "administrator", local, clock);
  await expect(reserveLiveCall(env.DB, "reviewer", "budget", clock, limits, "local")).rejects.toMatchObject({
    code: "budget_exhausted",
  });
});

it("serializes competing call starts against the fresh quota and renews the next UTC day", async (): Promise<void> => {
  await resetDailyQuotas(env.DB, "administrator", local, clock);
  const competing = await Promise.allSettled([
    reserveLiveCall(env.DB, "reviewer", "race-one", clock, { ...limits, reviewerConcurrency: 2 }, "local"),
    reserveLiveCall(env.DB, "reviewer", "race-two", clock, { ...limits, reviewerConcurrency: 2 }, "local"),
  ]);
  expect(competing.filter((entry): boolean => entry.status === "fulfilled")).toHaveLength(1);
  const result = competing.find((entry): boolean => entry.status === "fulfilled");
  if (result?.status !== "fulfilled") {
    throw new Error("Expected one call");
  }
  await finishCall(result.value.id, "reviewer");
  await expect(
    reserveLiveCall(env.DB, "reviewer", "tomorrow", "2026-11-17T00:00:00.000Z", limits, "local"),
  ).resolves.toHaveProperty("id");
});

it.each([
  ["reviewer", local],
  ["administrator", { ENVIRONMENT: "hosted", AUTH_MODE: "local" }],
  ["administrator", { ENVIRONMENT: "local", AUTH_MODE: "access" }],
])("rejects reset by %s with configuration %j", async (userId, configuration): Promise<void> => {
  await expect(resetDailyQuotas(env.DB, userId, configuration, clock)).rejects.toMatchObject({ code: "forbidden" });
  expect((await readState(env.DB)).state.quotaResets).toHaveLength(0);
});

it("requires an authenticated local administrator and an empty command body at the API boundary", async (): Promise<void> => {
  const headers = { Origin: "https://example.test", "Content-Type": "application/json" };
  expect(
    (await SELF.fetch("https://example.test/api/local/limits/reset", { method: "POST", headers, body: "{}" })).status,
  ).toBe(401);
  for (const userId of ["reviewer", "administrator"]) {
    const session = await SELF.fetch("https://example.test/api/session", {
      method: "POST",
      headers,
      body: JSON.stringify({ userId }),
    });
    const cookie = session.headers.get("set-cookie")!.split(";")[0];
    const response = await SELF.fetch("https://example.test/api/local/limits/reset", {
      method: "POST",
      headers: { ...headers, Cookie: cookie },
      body: "{}",
    });
    expect(response.status).toBe(userId === "administrator" ? 200 : 403);
    if (userId === "administrator") {
      expect(await response.json()).toMatchObject({ scope: "daily_calls", resetAt: expect.any(String) });
      expect(
        (
          await SELF.fetch("https://example.test/api/local/limits/reset", {
            method: "POST",
            headers: { ...headers, Cookie: cookie },
            body: JSON.stringify({ scope: "spending" }),
          })
        ).status,
      ).toBe(400);
    }
  }
});
