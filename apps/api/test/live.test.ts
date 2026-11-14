import { env, SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { reserveLiveCall, queryLiveStatus } from "@voice-freight/backend/live";
import { ingestProviderEvent } from "@voice-freight/backend/provider-events";
import { readState, transact } from "@voice-freight/backend/repository";
import {
  calculateAvailableMicrodollars,
  callReservationMicrodollars,
  monthlyLimitMicrodollars,
  shutdownHeadroomMicrodollars,
} from "@voice-freight/backend/spending";
import { queryCall, queryDashboard } from "@voice-freight/backend/reporting";
import { createSessionConfiguration } from "../src/live-configuration";
import { LiveCall } from "../src/live-call";

const clock = "2026-11-13T12:00:00.000Z";

beforeEach(async () => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name) => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

afterEach(async () => {
  const { state } = await readState(env.DB);
  for (const session of state.liveSessions) {
    const stub = env.CALLS.get(env.CALLS.idFromName(session.id));
    await runInDurableObject(stub, async (_instance, context) => {
      await context.storage.deleteAlarm();
      await context.storage.deleteAll();
    });
  }
});

async function openCall(userId = "reviewer", now = new Date().toISOString()) {
  const { id } = await reserveLiveCall(env.DB, userId, crypto.randomUUID(), now);
  const context = { userId, callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));
  await stub.start(context, "stub-offer");
  return { id, context, stub };
}

function createTranscriptEvent(speaker: "input" | "output", delta: string, startMs: number) {
  return {
    type: `session.${speaker}_transcript.delta`,
    event_id: crypto.randomUUID(),
    start_ms: startMs,
    end_ms: startMs + 500,
    delta,
  };
}

function createFunctionEvent(
  name: string,
  argumentsData: unknown,
  callId = crypto.randomUUID(),
  delegationId = crypto.randomUUID(),
) {
  return {
    type: "response.event",
    event_id: crypto.randomUUID(),
    delegation_id: delegationId,
    event: {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        name,
        arguments: JSON.stringify(argumentsData),
      },
    },
  };
}

it("configures native Responses delegation with the requested model and browser permissions", () => {
  const session = createSessionConfiguration();
  expect(session.model).toBe("gpt-live-1");
  expect(session.delegation).toMatchObject({
    type: "responses",
    responses: {
      model: "gpt-6-luna",
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
    },
  });
  expect(session.delegation.responses.tools).toHaveLength(7);
  expect(session.client.data_channel.allowed_client_events).not.toContain("response.create");
  expect(JSON.stringify(session.delegation.responses.tools)).not.toContain("readbackId");
});

it("reserves atomically across reviewers, deduplicates starts, and rejects insufficient allowance", async () => {
  const operationId = crypto.randomUUID();
  const first = await reserveLiveCall(env.DB, "reviewer", operationId, clock);
  expect(await reserveLiveCall(env.DB, "reviewer", operationId, clock)).toEqual(first);
  await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock)).rejects.toMatchObject({
    code: "concurrent_limit",
  });
  await transact(env.DB, (state) => {
    state.spendingPeriods.push({
      id: "2026-11",
      spentMicrodollars: monthlyLimitMicrodollars - callReservationMicrodollars * 2,
    });
  });
  const competing = await Promise.allSettled([
    reserveLiveCall(env.DB, "reviewer-two", crypto.randomUUID(), clock),
    reserveLiveCall(env.DB, "administrator", crypto.randomUUID(), clock),
  ]);
  expect(competing.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
  const { state } = await readState(env.DB);
  expect(calculateAvailableMicrodollars(state, clock)).toBe(0);
  await transact(env.DB, (draft) => {
    for (const session of draft.liveSessions) {
      session.state = "ended";
    }
  });
  await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock)).rejects.toMatchObject({
    code: "budget_exhausted",
  });
});

it("accounts cumulative voice, response IDs, failures, fractional rounding and month boundaries", async () => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), "2026-11-30T23:59:50.000Z");
  const context = { callId: id, userId: "reviewer" };
  await ingestProviderEvent(
    env.DB,
    context,
    {
      type: "session.usage.updated",
      event_id: "voice-a",
      usage: { seconds: 12 },
    },
    "2026-12-01T00:00:02.000Z",
  );
  await ingestProviderEvent(
    env.DB,
    context,
    {
      type: "session.usage.updated",
      event_id: "voice-b",
      usage: { seconds: 15 },
    },
    "2026-12-01T00:00:05.000Z",
  );
  await ingestProviderEvent(env.DB, context, {
    type: "session.usage.updated",
    event_id: "voice-replay",
    usage: { seconds: 12 },
  });
  const usage = {
    type: "response.event",
    delegation_id: "delegation",
    event: {
      type: "response.failed",
      response: {
        id: "response-a",
        created_at: Date.parse("2026-11-30T23:59:59Z") / 1000,
        usage: {
          input_tokens: 1000,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 100 },
        },
      },
    },
  };
  await ingestProviderEvent(env.DB, context, {
    ...usage,
    event_id: "response-a",
  });
  await ingestProviderEvent(env.DB, context, {
    ...usage,
    event_id: "response-replay",
  });
  const { state } = await readState(env.DB);
  expect(state.spendingPeriods).toEqual(
    expect.arrayContaining([
      { id: "2026-11", spentMicrodollars: 8334 + 93 },
      { id: "2026-12", spentMicrodollars: 4167 },
    ]),
  );
  expect(state.reservations[0].chargedMicrodollars).toBe(12594);
  expect(state.providerUsage).toHaveLength(3);
  expect(state.providerUsage.every((entry) => Number.isSafeInteger(entry.costMicrodollars))).toBe(true);
  expect(calculateAvailableMicrodollars(state, "2026-12-01T00:00:05Z")).toBe(
    monthlyLimitMicrodollars - 4167 - (callReservationMicrodollars - 12594),
  );
});

it("releases unattempted starts but retains reservations for uncertain provider failures", async () => {
  const first = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const stub = env.CALLS.get(env.CALLS.idFromName(first.id));
  await runInDurableObject(stub, async (_instance, context) => {
    const coordinator = new LiveCall(context, {
      ...env,
      VOICE_PROVIDER: "openai",
      OPENAI_API_KEY: undefined,
    });
    await expect(coordinator.start({ userId: "reviewer", callId: first.id }, "offer")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
  expect((await readState(env.DB)).state.reservations.find((entry) => entry.id === first.id)?.settled).toBe(true);
  const second = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 503 }));
  try {
    await runInDurableObject(env.CALLS.get(env.CALLS.idFromName(second.id)), async (_instance, context) => {
      const coordinator = new LiveCall(context, {
        ...env,
        VOICE_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
      });
      await expect(coordinator.start({ userId: "reviewer", callId: second.id }, "offer")).rejects.toMatchObject({
        code: "provider_unavailable",
      });
    });
    expect((await readState(env.DB)).state.reservations.find((entry) => entry.id === second.id)?.settled).toBe(false);
    const retry = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
    provider.mockRejectedValue(new TypeError("Network outcome unknown"));
    const retryStub = env.CALLS.get(env.CALLS.idFromName(retry.id));
    await runInDurableObject(retryStub, async (_instance, context) => {
      const coordinator = new LiveCall(context, {
        ...env,
        VOICE_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
      });
      await expect(coordinator.start({ userId: "reviewer", callId: retry.id }, "offer")).rejects.toMatchObject({
        code: "provider_unavailable",
      });
    });
    await transact(env.DB, (state) => {
      state.liveSessions.find((entry) => entry.id === retry.id)!.closingAt = new Date(
        Date.now() - 11_000,
      ).toISOString();
    });
    await runDurableObjectAlarm(retryStub);
    await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID())).rejects.toMatchObject({
      code: "concurrent_limit",
    });
  } finally {
    provider.mockRestore();
  }
});

it("runs the full coordinator and Tools RPC workflow with cancellation, replacement and saved final facts", async () => {
  const { id, context, stub } = await openCall();
  await stub.runFixture("workflow");
  const before = await queryCall(env.DB, context);
  expect(before.agreements.map((entry) => entry.status)).toEqual(["cancelled", "superseded", "effective"]);
  const output = await stub.getFixtureOutput();
  expect(output.filter((event) => event.type === "response.item.create")).toHaveLength(11);
  await stub.end();
  const final = await queryCall(env.DB, context);
  expect(final.transcript.complete).toBe(true);
  expect(final.analysis.status).toBe("pending");
  expect(final.loads).toHaveLength(2);
  expect((await queryDashboard(env.DB, "reviewer")).report.finalAgreementCount).toBe(1);
  const { state } = await readState(env.DB);
  expect(state.reservations.find((entry) => entry.id === id)?.settled).toBe(true);
  expect(state.evidence).toHaveLength(8);
  expect(final.transcript.entries).toHaveLength(8);
  const late = createFunctionEvent("confirm_handoff", { quoteId: "old" });
  await stub.observeFixture(late);
  expect((await queryCall(env.DB, context)).agreements).toEqual(final.agreements);
});

it("rejects invented, ambiguous, overlapping and stale confirmations while replaying saved tool results", async () => {
  const { context, stub } = await openCall();
  const verify = createFunctionEvent("verify_carrier", { mcNumber: "123456" });
  await stub.observeFixture(verify);
  await stub.observeFixture({ ...verify, event_id: "verify-replay" });
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }));
  let current = (await readState(env.DB)).state.calls.find((call) => call.id === context.callId)!;
  const quoteId = current.quoteId!;
  await stub.observeFixture(
    createFunctionEvent("confirm_handoff", {
      quoteId,
      evidence: { readbackId: "invented", callerId: "invented" },
    }),
  );
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  const text = "Summit Transport, load NS-seed-v1-01, at $2,000. Please confirm.";
  await stub.observeFixture(createTranscriptEvent("output", text, 1000));
  await stub.observeFixture(createTranscriptEvent("input", "Yes, but change the load.", 2000));
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  await stub.observeFixture(createTranscriptEvent("output", text, 3000));
  await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 3100));
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-02" }));
  current = (await readState(env.DB)).state.calls.find((call) => call.id === context.callId)!;
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId: current.quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  await stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "234567" }));
  expect((await readState(env.DB)).state.calls.find((call) => call.id === context.callId)?.quoteId).toBe(
    current.quoteId,
  );
  const { state } = await readState(env.DB);
  expect(state.receipts.filter((receipt) => receipt.id.endsWith(verify.event.item.call_id))).toHaveLength(1);
});

it("finalizes abandoned calls and closes with spending headroom, preserving uncertain usage", async () => {
  const { id, context, stub } = await openCall();
  await transact(env.DB, (state) => {
    const session = state.liveSessions.find((entry) => entry.id === id)!;
    session.lastInputAt = new Date(Date.now() - 50_000).toISOString();
  });
  await runDurableObjectAlarm(stub);
  expect((await queryLiveStatus(env.DB, context)).notice).toContain("15 seconds");
  await stub.observeFixture(createTranscriptEvent("input", "Still here.", 1000));
  expect((await queryLiveStatus(env.DB, context)).notice).toBeNull();
  await transact(env.DB, (state) => {
    state.reservations.find((entry) => entry.id === id)!.reservedMicrodollars = shutdownHeadroomMicrodollars;
  });
  await runDurableObjectAlarm(stub);
  expect(await queryLiveStatus(env.DB, context)).toMatchObject({
    state: "ended",
    notice: expect.stringContaining("allowance"),
  });
  expect((await queryCall(env.DB, context)).endedAt).not.toBeNull();
  const other = await openCall("reviewer-two");
  await other.stub.observeFixture({
    type: "response.event",
    event_id: "pending",
    delegation_id: "pending",
    event: { type: "response.created", response: { id: "unfinished" } },
  });
  await other.stub.end();
  expect((await readState(env.DB)).state.reservations.find((entry) => entry.id === other.id)?.settled).toBe(false);
});

it("authorizes SDP creation and hang-up through the real API and blocks browser evidence paths", async () => {
  const headers = {
    Origin: "http://localhost",
    "Content-Type": "application/json",
  };
  const signIn = await SELF.fetch("http://localhost/api/session", {
    method: "POST",
    headers,
    body: JSON.stringify({ userId: "reviewer" }),
  });
  const Cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const response = await SELF.fetch("http://localhost/api/live/calls", {
    method: "POST",
    headers: { ...headers, Cookie },
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      offerSdp: "stub-offer",
    }),
  });
  expect(response.status).toBe(201);
  const { id } = await response.json<{ id: string }>();
  expect((await SELF.fetch(`http://localhost/api/calls/${id}/live`)).status).toBe(401);
  expect(
    (
      await SELF.fetch(`http://localhost/api/calls/${id}/tools/select_load`, {
        method: "POST",
        headers: { ...headers, Cookie },
        body: JSON.stringify({
          invocationId: "browser",
          arguments: { loadId: "seed-v1-01" },
        }),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await SELF.fetch(`http://localhost/api/calls/${id}/hangup`, {
        method: "POST",
        headers: { ...headers, Cookie },
        body: "{}",
      })
    ).status,
  ).toBe(200);
});

it("requires the exact rate and a fresh read-back, then rejects confirmations after hang-up", async () => {
  const { context, stub } = await openCall();
  await stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }));
  const quoteId = (await readState(env.DB)).state.calls.find((entry) => entry.id === context.callId)!.quoteId;
  await stub.observeFixture(
    createTranscriptEvent("output", "Summit Transport, load NS-seed-v1-01, at $2,000.50. Please confirm.", 1000),
  );
  await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 2000));
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  await stub.observeFixture(
    createTranscriptEvent("output", "Summit Transport, load NS-seed-v1-01, at $2,000.00. Please confirm.", 3000),
  );
  await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 4000));
  await stub.end();
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
});

it("enforces UTC daily limits, reclaims abandoned unattempted starts and renews the next day", async () => {
  for (let index = 0; index < 6; index++) {
    await reserveLiveCall(
      env.DB,
      "reviewer",
      crypto.randomUUID(),
      `2026-11-13T12:${String(index).padStart(2, "0")}:00.000Z`,
    );
  }
  await expect(
    reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), "2026-11-13T12:10:00.000Z"),
  ).rejects.toMatchObject({ code: "daily_limit" });
  await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), "2026-11-14T00:00:00.000Z");
  const { state } = await readState(env.DB);
  expect(state.reservations.filter((entry) => entry.settled)).toHaveLength(6);
  expect(state.calls.filter((entry) => entry.finalSnapshot)).toHaveLength(6);
});

it("preserves usage and agreement facts when a restarted coordinator finalizes the call", async () => {
  const { id, context, stub } = await openCall();
  await stub.runFixture("workflow");
  await runInDurableObject(stub, async (_instance, storage) => {
    const restarted = new LiveCall(storage, {
      ...env,
      VOICE_PROVIDER: "openai",
      OPENAI_API_KEY: undefined,
    });
    await restarted.alarm();
  });
  expect(await queryCall(env.DB, context)).toMatchObject({
    connection: "Interrupted",
    transcript: { complete: false },
  });
  expect((await queryDashboard(env.DB, "reviewer")).report.finalAgreementCount).toBe(1);
  expect((await readState(env.DB)).state.reservations.find((entry) => entry.id === id)?.settled).toBe(false);
});

it("retains ordered fragments, deduplicates replay, and drains transcripts without changing final facts", async () => {
  const { id, context, stub } = await openCall();
  const first = {
    ...createTranscriptEvent("output", "Hel", 0),
    event_id: "z-first",
  };
  await stub.observeFixture(first);
  await stub.observeFixture({ ...first, event_id: "a-second", delta: "lo" });
  await stub.observeFixture(first);
  expect((await queryLiveStatus(env.DB, context)).transcript.map((entry) => entry.text)).toEqual(["Hello"]);
  await stub.end();
  const snapshot = (await readState(env.DB)).state.calls.find((entry) => entry.id === id)!.finalSnapshot;
  await ingestProviderEvent(env.DB, context, createTranscriptEvent("input", "Thanks.", 1000));
  expect((await queryCall(env.DB, context)).transcript.entries.map((entry) => entry.text)).toEqual([
    "Hello",
    "Thanks.",
  ]);
  expect((await readState(env.DB)).state.calls.find((entry) => entry.id === id)!.finalSnapshot).toEqual(snapshot);
  expect((await readState(env.DB)).state.transcriptFragments).toHaveLength(3);
});

it("checks complete spoken amounts and action intent while allowing fresh read-backs after acknowledgments", async () => {
  const { context, stub } = await openCall();
  await stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }));
  let quoteId = (await readState(env.DB)).state.calls.find((entry) => entry.id === context.callId)!.quoteId;
  for (const [index, text] of [
    "Summit Transport, load NS-seed-v1-01, at two thousand dollars and twenty five cents. Please confirm.",
    "Cancel Summit Transport, load NS-seed-v1-01, at two thousand dollars. Please confirm.",
  ].entries()) {
    await stub.observeFixture(createTranscriptEvent("output", text, 1000 + index * 2000));
    await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 2000 + index * 2000));
    await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
    expect((await queryCall(env.DB, context)).agreements).toHaveLength(0);
  }
  await stub.observeFixture(createFunctionEvent("evaluate_offer", { quoteId, amountCents: 200025 }));
  quoteId = (await readState(env.DB)).state.calls.find((entry) => entry.id === context.callId)!.quoteId;
  await stub.observeFixture(
    createTranscriptEvent(
      "output",
      "Summit Transport, load NS-seed-v1-01, at two thousand dollars and twenty five cents. Please confirm.",
      5000,
    ),
  );
  await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 6000));
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toMatchObject([{ rateCents: 200025 }]);
  await stub.observeFixture(createTranscriptEvent("output", "Let me check.", 7000));
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-02" }));
  quoteId = (await readState(env.DB)).state.calls.find((entry) => entry.id === context.callId)!.quoteId;
  await stub.observeFixture(
    createTranscriptEvent(
      "output",
      "Summit Transport, load NS-seed-v1-02, at two thousand fifty dollars. Please confirm.",
      7600,
    ),
  );
  await stub.observeFixture(createTranscriptEvent("input", "Yes, confirmed.", 8600));
  await stub.observeFixture(createFunctionEvent("confirm_handoff", { quoteId }));
  expect((await queryCall(env.DB, context)).agreements).toHaveLength(2);
});

it("continues new work in a delegation after replaying a submitted function call", async () => {
  const { stub, context } = await openCall();
  const first = createFunctionEvent("verify_carrier", { mcNumber: "123456" }, "first", "delegation");
  await stub.observeFixture(first);
  await stub.observeFixture({ ...first, event_id: "replayed-envelope" });
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }, "second", "delegation"));
  expect((await stub.getFixtureOutput()).filter((event) => event.type === "response.create")).toHaveLength(2);
  expect((await readState(env.DB)).state.receipts.filter((receipt) => receipt.callId === context.callId)).toHaveLength(
    2,
  );
});

it("repairs interrupted closing states before settling or timing out", async () => {
  const first = await openCall();
  await first.stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
  await first.stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }));
  await transact(env.DB, (state) => {
    state.liveSessions.find((entry) => entry.id === first.id)!.state = "ending";
  });
  await first.stub.observeFixture({
    type: "session.closed",
    event_id: "recovered-close",
    usage: { seconds: 1 },
  });
  expect((await queryCall(env.DB, first.context)).endedAt).not.toBeNull();
  expect((await readState(env.DB)).state.quotes.every((entry) => !entry.valid)).toBe(true);
  const second = await openCall("reviewer-two");
  await transact(env.DB, (state) => {
    state.liveSessions.find((entry) => entry.id === second.id)!.state = "ending";
  });
  await runDurableObjectAlarm(second.stub);
  const closingAt = (await readState(env.DB)).state.liveSessions.find((entry) => entry.id === second.id)!.closingAt;
  expect(closingAt).not.toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.parse(closingAt!) + 11_000);
    await runDurableObjectAlarm(second.stub);
    expect((await queryLiveStatus(env.DB, second.context)).state).toBe("ended");
    expect((await queryCall(env.DB, second.context)).endedAt).not.toBeNull();
    expect((await readState(env.DB)).state.reservations.find((entry) => entry.id === second.id)?.settled).toBe(false);
    await expect(reserveLiveCall(env.DB, "reviewer-two", crypto.randomUUID())).rejects.toMatchObject({
      code: "concurrent_limit",
    });
  } finally {
    vi.useRealTimers();
  }
});
