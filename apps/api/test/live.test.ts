import { executeTool } from "@voice-freight/backend/business";
import { addInventory } from "@voice-freight/backend/inventory";
import { env, SELF, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { reserveLiveCall, queryLiveStatus, queryTranscript } from "@voice-freight/backend/live";
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

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

afterEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);

  for (const session of state.liveSessions) {
    const stub = env.CALLS.get(env.CALLS.idFromName(session.id));

    await runInDurableObject(stub, async (_instance, context): Promise<void> => {
      await context.storage.deleteAlarm();
      await context.storage.deleteAll();
    });
  }
});

async function openCall(
  userId = "reviewer",
  now = new Date().toISOString(),
): Promise<{ id: string; context: { userId: string; callId: string }; stub: DurableObjectStub<LiveCall> }> {
  const { id } = await reserveLiveCall(env.DB, userId, crypto.randomUUID(), now);
  const context = { userId, callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));
  await stub.start(context, "stub-offer");
  return { id, context, stub };
}

function createTranscriptEvent(
  speaker: "input" | "output",
  delta: string,
  startMs: number,
): { type: string; event_id: string; start_ms: number; end_ms: number; delta: string } {
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
): {
  type: string;
  event_id: string;
  delegation_id: string;
  event: { type: string; item: { type: string; call_id: string; name: string; arguments: string } };
} {
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

it("configures native Responses delegation with the requested model and browser permissions", (): void => {
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

  expect(session.delegation.responses.tools).toHaveLength(8);
  expect(session.delegation.responses.tools).toContainEqual(
    expect.objectContaining({
      name: "end_call",
      parameters: expect.objectContaining({ properties: {}, additionalProperties: false }),
    }),
  );
  expect(JSON.stringify(session)).not.toMatch(/synthetic|simulated|\bdemo\b/i);
  expect(session.client.data_channel.allowed_client_events).not.toContain("response.create");
  expect(JSON.stringify(session.delegation.responses.tools)).not.toContain("readbackId");
});

it("reserves atomically across reviewers, deduplicates starts, and rejects insufficient allowance", async (): Promise<void> => {
  const operationId = crypto.randomUUID();
  const first = await reserveLiveCall(env.DB, "reviewer", operationId, clock);
  expect(await reserveLiveCall(env.DB, "reviewer", operationId, clock)).toEqual(first);

  await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock)).rejects.toMatchObject({
    code: "concurrent_limit",
  });

  await transact(env.DB, (state): void => {
    state.spendingPeriods.push({
      id: "2026-11",
      spentMicrodollars: monthlyLimitMicrodollars - callReservationMicrodollars * 2,
    });
  });

  const competing = await Promise.allSettled([
    reserveLiveCall(env.DB, "reviewer-two", crypto.randomUUID(), clock),
    reserveLiveCall(env.DB, "administrator", crypto.randomUUID(), clock),
  ]);

  expect(competing.filter((entry): boolean => entry.status === "fulfilled")).toHaveLength(1);
  const { state } = await readState(env.DB);
  expect(calculateAvailableMicrodollars(state, clock)).toBe(0);

  await transact(env.DB, (draft): void => {
    for (const session of draft.liveSessions) {
      session.state = "ended";
    }
  });

  await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock)).rejects.toMatchObject({
    code: "budget_exhausted",
  });
});

it("accounts cumulative voice, response IDs, failures, fractional rounding and month boundaries", async (): Promise<void> => {
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
  expect(state.providerUsage.every((entry): boolean => Number.isSafeInteger(entry.costMicrodollars))).toBe(true);

  expect(calculateAvailableMicrodollars(state, "2026-12-01T00:00:05Z")).toBe(
    monthlyLimitMicrodollars - 4167 - (callReservationMicrodollars - 12594),
  );
});

it("releases unattempted starts but retains reservations for uncertain provider failures", async (): Promise<void> => {
  const first = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const stub = env.CALLS.get(env.CALLS.idFromName(first.id));

  await runInDurableObject(stub, async (_instance, context): Promise<void> => {
    const coordinator = new LiveCall(context, {
      ...env,
      VOICE_PROVIDER: "openai",
      OPENAI_API_KEY: undefined,
    });

    await expect(coordinator.start({ userId: "reviewer", callId: first.id }, "offer")).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });

  expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === first.id)?.settled).toBe(
    true,
  );

  const second = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const provider = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 503 }));

  try {
    await runInDurableObject(
      env.CALLS.get(env.CALLS.idFromName(second.id)),
      async (_instance, context): Promise<void> => {
        const coordinator = new LiveCall(context, {
          ...env,
          VOICE_PROVIDER: "openai",
          OPENAI_API_KEY: "test-key",
        });

        await expect(coordinator.start({ userId: "reviewer", callId: second.id }, "offer")).rejects.toMatchObject({
          code: "provider_unavailable",
        });
      },
    );

    expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === second.id)?.settled).toBe(
      false,
    );

    const retry = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
    provider.mockRejectedValue(new TypeError("Network outcome unknown"));
    const retryStub = env.CALLS.get(env.CALLS.idFromName(retry.id));

    await runInDurableObject(retryStub, async (_instance, context): Promise<void> => {
      const coordinator = new LiveCall(context, {
        ...env,
        VOICE_PROVIDER: "openai",
        OPENAI_API_KEY: "test-key",
      });

      await expect(coordinator.start({ userId: "reviewer", callId: retry.id }, "offer")).rejects.toMatchObject({
        code: "provider_unavailable",
      });
    });

    await transact(env.DB, (state): void => {
      state.liveSessions.find((entry): boolean => entry.id === retry.id)!.closingAt = new Date(
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

it("runs the full coordinator and Tools RPC workflow with cancellation, replacement and saved final facts", async (): Promise<void> => {
  const { id, context, stub } = await openCall();
  await stub.runFixture("workflow");
  const before = await queryCall(env.DB, context);

  expect(before.agreements.map((entry): typeof entry.status => entry.status)).toEqual([
    "cancelled",
    "superseded",
    "effective",
  ]);

  const output = await stub.getFixtureOutput();
  expect(output.filter((event): boolean => event.type === "response.item.create")).toHaveLength(11);
  await stub.end();
  const final = await queryCall(env.DB, context);
  expect(final.transcript.complete).toBe(true);
  expect(final.analysis.status).toBe("pending");
  expect(final.loads).toHaveLength(2);
  expect((await queryDashboard(env.DB, "reviewer")).report.finalAgreementCount).toBe(1);
  const { state } = await readState(env.DB);
  expect(state.reservations.find((entry): boolean => entry.id === id)?.settled).toBe(true);
  expect(state.evidence).toHaveLength(8);
  expect(final.transcript.entries.filter((entry): boolean => entry.speaker === "carrier")).toHaveLength(4);
  expect(final.transcript.entries.filter((entry): boolean => entry.text.includes("Please confirm"))).toHaveLength(4);
  const late = createFunctionEvent("confirm_handoff", { quoteId: "old" });
  await stub.observeFixture(late);
  expect((await queryCall(env.DB, context)).agreements).toEqual(final.agreements);
});

it("finalizes abandoned calls and closes with spending headroom, preserving uncertain usage", async (): Promise<void> => {
  const { id, context, stub } = await openCall();

  await transact(env.DB, (state): void => {
    const session = state.liveSessions.find((entry): boolean => entry.id === id)!;
    session.lastInputAt = new Date(Date.now() - 50_000).toISOString();
  });

  await runDurableObjectAlarm(stub);
  expect((await queryLiveStatus(env.DB, context)).notice).toContain("15 seconds");
  await stub.observeFixture(createTranscriptEvent("input", "Still here.", 1000));
  expect((await queryLiveStatus(env.DB, context)).notice).toBeNull();

  await transact(env.DB, (state): void => {
    state.reservations.find((entry): boolean => entry.id === id)!.reservedMicrodollars = shutdownHeadroomMicrodollars;
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

  expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === other.id)?.settled).toBe(
    false,
  );
});

it("authorizes SDP creation and hang-up through the real API and blocks browser evidence paths", async (): Promise<void> => {
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
  expect((await SELF.fetch(`http://localhost/api/calls/${id}/transcript`)).status).toBe(401);
  const stub = env.CALLS.get(env.CALLS.idFromName(id));
  const event = createTranscriptEvent("input", "Confirmed.", 1200);
  await stub.observeFixture(event);
  await stub.observeFixture(event);
  const transcript = await SELF.fetch(`http://localhost/api/calls/${id}/transcript`, { headers: { Cookie } });
  expect(transcript.status).toBe(200);

  expect(await transcript.json()).toEqual({
    fragments: [
      {
        id: `${id}:${event.event_id}`,
        speaker: "carrier",
        startMs: 1200,
        endMs: 1700,
        text: "Confirmed.",
      },
    ],
  });

  const other = await openCall("administrator");

  expect((await SELF.fetch(`http://localhost/api/calls/${other.id}/transcript`, { headers: { Cookie } })).status).toBe(
    404,
  );

  expect(
    await (await SELF.fetch(`http://localhost/api/calls/${id}/live`, { headers: { Cookie } })).json(),
  ).not.toHaveProperty("transcript");

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

it("excludes confirmation and analysis spending from daily call quotas", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock);
  await transact(env.DB, (state): void => {
    const reservation = state.reservations.find((entry): boolean => entry.id === id)!;
    state.liveSessions.find((entry): boolean => entry.id === id)!.state = "ended";
    reservation.settled = true;

    for (const kind of ["confirmation", "analysis"] as const) {
      for (let index = 0; index < 40; index++) {
        state.reservations.push({
          ...reservation,
          id: `${kind}-${index}`,
          operationId: `${kind}-${index}`,
          kind,
          reservedMicrodollars: 0,
          chargedMicrodollars: 0,
        });
      }
    }
  });

  await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock)).resolves.toMatchObject({
    id: expect.any(String),
  });
});

it("enforces UTC daily limits, reclaims abandoned unattempted starts and renews the next day", async (): Promise<void> => {
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
  expect(state.reservations.filter((entry): typeof entry.settled => entry.settled)).toHaveLength(6);
  expect(state.calls.filter((entry): typeof entry.finalSnapshot => entry.finalSnapshot)).toHaveLength(6);
});

it("preserves usage and agreement facts when a restarted coordinator finalizes the call", async (): Promise<void> => {
  const { id, context, stub } = await openCall();
  await stub.runFixture("workflow");

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
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
  expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === id)?.settled).toBe(false);
});

it("retains ordered fragments, deduplicates replay, and drains transcripts without changing final facts", async (): Promise<void> => {
  const { id, context, stub } = await openCall();

  const first = {
    ...createTranscriptEvent("output", "Hel", 0),
    event_id: "z-first",
  };

  await stub.observeFixture(first);
  await stub.observeFixture({ ...first, event_id: "a-second", delta: "lo" });
  await stub.observeFixture(first);
  expect((await queryTranscript(env.DB, context)).fragments.map((entry): string => entry.text)).toEqual(["Hel", "lo"]);
  expect(await queryLiveStatus(env.DB, context)).not.toHaveProperty("transcript");
  await stub.end();
  const snapshot = (await readState(env.DB)).state.calls.find((entry): boolean => entry.id === id)!.finalSnapshot;
  await ingestProviderEvent(env.DB, context, createTranscriptEvent("input", "Thanks.", 1000));

  expect((await queryCall(env.DB, context)).transcript.entries.map((entry): typeof entry.text => entry.text)).toEqual([
    "Hello",
    "Thanks.",
  ]);

  expect((await readState(env.DB)).state.calls.find((entry): boolean => entry.id === id)!.finalSnapshot).toEqual(
    snapshot,
  );

  expect((await readState(env.DB)).state.transcriptFragments).toHaveLength(3);
});

it("continues new work in a delegation after replaying a submitted function call", async (): Promise<void> => {
  const { stub, context } = await openCall();
  const first = createFunctionEvent("verify_carrier", { mcNumber: "123456" }, "first", "delegation");
  await stub.observeFixture(first);
  await stub.observeFixture({ ...first, event_id: "replayed-envelope" });
  await stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }, "second", "delegation"));
  expect((await stub.getFixtureOutput()).filter((event): boolean => event.type === "response.create")).toHaveLength(2);

  expect(
    (await readState(env.DB)).state.receipts.filter((receipt): boolean => receipt.callId === context.callId),
  ).toHaveLength(2);
});

it("repairs interrupted closing states before settling or timing out", async (): Promise<void> => {
  const first = await openCall();
  await first.stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
  await first.stub.observeFixture(createFunctionEvent("select_load", { loadId: "seed-v1-01" }));

  await transact(env.DB, (state): void => {
    state.liveSessions.find((entry): boolean => entry.id === first.id)!.state = "ending";
  });

  await first.stub.observeFixture({
    type: "session.closed",
    event_id: "recovered-close",
    usage: { seconds: 1 },
  });

  expect((await queryCall(env.DB, first.context)).endedAt).not.toBeNull();
  expect((await readState(env.DB)).state.quotes.every((entry): boolean => !entry.valid)).toBe(true);
  const second = await openCall("reviewer-two");

  await transact(env.DB, (state): void => {
    state.liveSessions.find((entry): boolean => entry.id === second.id)!.state = "ending";
  });

  await runDurableObjectAlarm(second.stub);

  const closingAt = (await readState(env.DB)).state.liveSessions.find(
    (entry): boolean => entry.id === second.id,
  )!.closingAt;

  expect(closingAt).not.toBeNull();
  vi.useFakeTimers({ toFake: ["Date"] });

  try {
    vi.setSystemTime(Date.parse(closingAt!) + 11_000);
    await runDurableObjectAlarm(second.stub);
    expect((await queryLiveStatus(env.DB, second.context)).state).toBe("ended");
    expect((await queryCall(env.DB, second.context)).endedAt).not.toBeNull();

    expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === second.id)?.settled).toBe(
      false,
    );

    await expect(reserveLiveCall(env.DB, "reviewer-two", crypto.randomUUID())).rejects.toMatchObject({
      code: "concurrent_limit",
    });
  } finally {
    vi.useRealTimers();
  }
});

it("distinguishes identical route/date loads with stable spoken options", async (): Promise<void> => {
  await transact(env.DB, (state): void => {
    addInventory(state, "second", clock);
  });

  const { context } = await openCall();
  await executeTool(env.DB, context, "verify_carrier", { invocationId: "verify", arguments: { mcNumber: "123456" } });

  const search = await executeTool(env.DB, context, "search_loads", {
    invocationId: "search",
    arguments: { origin: "Dallas" },
  });

  if (!("loads" in search)) {
    throw new Error("Expected loads");
  }

  expect(search.loads.find((load): boolean => load.id === "seed-v1-01")?.spokenLabel).toContain("option 1");
  expect(search.loads.find((load): boolean => load.id === "second-01")?.spokenLabel).toContain("option 2");

  const quote = await executeTool(env.DB, context, "select_load", {
    invocationId: "select",
    arguments: { loadId: "seed-v1-01" },
  });

  if (!("quoteId" in quote)) {
    throw new Error("Expected quote");
  }

  expect(quote.readback).toContain("option 1");
});

it("describes pickup dates and times in the origin time zone across midnight and daylight saving", async (): Promise<void> => {
  await transact(env.DB, (state): void => {
    state.inventory.find((entry): boolean => entry.id === "seed-v1-01")!.load.pickupAt = "2026-03-08T07:30:00.000Z";
    state.inventory.find((entry): boolean => entry.id === "seed-v1-04")!.load.pickupAt = "2026-03-08T06:30:00.000Z";
    state.inventory.find((entry): boolean => entry.id === "seed-v1-05")!.load.pickupAt = "2026-03-08T07:30:00.000Z";
  });

  const { context } = await openCall();
  await executeTool(env.DB, context, "verify_carrier", { invocationId: "verify", arguments: { mcNumber: "123456" } });
  for (const [id, expected] of [
    ["01", "1:30 AM Central Standard Time"],
    ["04", "March 7, 2026 at 11:30 PM Mountain Standard Time"],
    ["05", "3:30 AM Eastern Daylight Time"],
  ]) {
    const search = await executeTool(env.DB, context, "search_loads", {
      invocationId: `search-${id}`,
      arguments: { reference: `NS-seed-v1-${id}` },
    });
    if (!("loads" in search)) {
      throw new Error("Expected loads");
    }
    expect(search.loads[0]?.spokenLabel).toContain(expected);
  }
});

it("ends before verification after a bounded goodbye and ignores duplicate or late work", async (): Promise<void> => {
  const { id, context, stub } = await openCall();
  vi.useFakeTimers({ toFake: ["Date"] });

  try {
    const start = Date.now();
    const ending = createFunctionEvent("end_call", {}, "goodbye", "farewell");
    await stub.observeFixture(ending);
    expect(await queryLiveStatus(env.DB, context)).toMatchObject({ state: "ending", endedAt: null });
    const farewell = (await readState(env.DB)).state.liveSessions[0].farewell;
    expect(farewell).toEqual({ deadline: new Date(start + 4000).toISOString(), delegationId: "farewell" });
    const output = await stub.getFixtureOutput();
    expect(output.filter((event): boolean => event.type === "response.item.create")).toHaveLength(1);
    expect(output.filter((event): boolean => event.type === "response.create")).toHaveLength(1);
    expect(output.some((event): boolean => event.type === "session.input_audio.mute")).toBe(true);

    await stub.observeFixture({ ...ending, event_id: "replayed-ending" });
    await stub.observeFixture(createFunctionEvent("end_call", {}, "another-goodbye", "another-delegation"));
    await stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
    expect(await stub.getFixtureOutput()).toEqual(output);
    expect((await readState(env.DB)).state.liveSessions[0].farewell).toEqual(farewell);
    await expect(
      executeTool(env.DB, context, "verify_carrier", { invocationId: "late-rest", arguments: { mcNumber: "123456" } }),
    ).rejects.toMatchObject({ code: "call_ended" });
    expect((await readState(env.DB)).state.calls[0].verification).toBeNull();

    await stub.observeFixture(createTranscriptEvent("output", "Thank you for calling. Goodbye.", 1000));
    vi.setSystemTime(start + 3999);
    await runDurableObjectAlarm(stub);
    expect((await queryLiveStatus(env.DB, context)).state).toBe("ending");
    vi.setSystemTime(start + 4000);
    await runDurableObjectAlarm(stub);
    expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
    expect(await queryCall(env.DB, context)).toMatchObject({
      connection: "Ended normally",
      transcript: { complete: true, entries: [expect.objectContaining({ text: "Thank you for calling. Goodbye." })] },
    });
    expect((await readState(env.DB)).state.reservations.find((entry): boolean => entry.id === id)?.settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects invalid end-call arguments without disconnecting", async (): Promise<void> => {
  const { context, stub } = await openCall();
  await stub.observeFixture(createFunctionEvent("end_call", { reason: "invented" }));
  expect((await queryLiveStatus(env.DB, context)).state).toBe("connected");
  expect(
    (await stub.getFixtureOutput()).find((event): boolean => event.type === "response.item.create")?.json,
  ).toContain("invalid_input");
  await stub.observeFixture(createFunctionEvent("verify_carrier", { mcNumber: "123456" }));
  expect((await readState(env.DB)).state.calls[0].verification?.status).toBe("eligible");
});

it("preserves the farewell deadline and saved agreements across a coordinator restart", async (): Promise<void> => {
  const { context, stub } = await openCall();
  await stub.runFixture("workflow");
  const agreements = (await queryCall(env.DB, context)).agreements;
  await stub.observeFixture(createFunctionEvent("end_call", {}));
  const farewell = (await readState(env.DB)).state.liveSessions[0].farewell!;
  vi.useFakeTimers({ toFake: ["Date"] });

  try {
    vi.setSystemTime(Date.parse(farewell.deadline) - 1000);
    await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
      const restarted = new LiveCall(storage, env);
      await restarted.alarm();
      expect((await readState(env.DB)).state.liveSessions[0].farewell).toEqual(farewell);
      vi.setSystemTime(Date.parse(farewell.deadline));
      await restarted.alarm();
    });

    expect(await queryCall(env.DB, context)).toMatchObject({
      connection: "Ended normally",
      agreements,
      transcript: { complete: true },
    });
    expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
  } finally {
    vi.useRealTimers();
  }
});

it("bypasses the goodbye window for manual hang-up and spending limits", async (): Promise<void> => {
  const first = await openCall();
  await first.stub.observeFixture(createFunctionEvent("end_call", {}));
  await first.stub.end();
  expect((await queryLiveStatus(env.DB, first.context)).state).toBe("ended");
  expect((await readState(env.DB)).state.liveSessions[0].farewell).toBeUndefined();

  const second = await openCall();
  await second.stub.observeFixture(createFunctionEvent("end_call", {}));
  await transact(env.DB, (state): void => {
    state.reservations.find((entry): boolean => entry.id === second.id)!.reservedMicrodollars =
      shutdownHeadroomMicrodollars;
  });

  await runDurableObjectAlarm(second.stub);
  expect(await queryLiveStatus(env.DB, second.context)).toMatchObject({
    state: "ended",
    notice: expect.stringContaining("spending allowance"),
  });
});

it("keeps usage and concurrency unconfirmed when farewell closure is not acknowledged", async (): Promise<void> => {
  const { id, context, stub } = await openCall();
  await stub.observeFixture(createFunctionEvent("end_call", {}));
  const farewell = (await readState(env.DB)).state.liveSessions[0].farewell!;
  vi.useFakeTimers({ toFake: ["Date"] });

  try {
    vi.setSystemTime(Date.parse(farewell.deadline));
    await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
      const restarted = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: undefined });
      await storage.storage.put("recoveryAttempts", 2);
      await restarted.alarm();
      expect((await queryLiveStatus(env.DB, context)).state).toBe("ending");
      vi.setSystemTime(Date.now() + 11_000);
      await restarted.alarm();
    });

    expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
    expect(await queryCall(env.DB, context)).toMatchObject({
      connection: "Ended normally",
      transcript: { complete: false },
    });
    const { state } = await readState(env.DB);
    expect(state.reservations.find((entry): boolean => entry.id === id)?.settled).toBe(false);
    expect(state.liveSessions[0].providerClosed).toBe(false);
    await expect(reserveLiveCall(env.DB, "reviewer", crypto.randomUUID())).rejects.toMatchObject({
      code: "concurrent_limit",
    });
  } finally {
    vi.useRealTimers();
  }
});

it("projects fresh and legacy business results for voice without changing saved provenance or notes", async (): Promise<void> => {
  const { context, stub } = await openCall();
  const verification = createFunctionEvent("verify_carrier", { mcNumber: "123456" });
  await stub.observeFixture(verification);
  await transact(env.DB, (state): void => {
    state.inventory[0].load.commodity = "Palletized demo goods";
    state.inventory[0].load.notes = "Synthetic inventory. Simulated handoff only.";
    state.inventory[5].load.notes = "Call the receiver before arrival.";
  });

  await stub.observeFixture(createFunctionEvent("search_loads", { origin: "Texas" }));
  const output = (await stub.getFixtureOutput()).filter((event): boolean => event.type === "response.item.create");
  expect(output.map((event): string => event.json).join(" ")).not.toMatch(/synthetic|simulated|\bdemo\b|fixture/i);
  expect(output[1].json).toContain("Call the receiver before arrival.");
  expect(output[1].json).toContain("Palletized goods");
  const before = (await readState(env.DB)).state;
  expect(before.inventory[0].load.notes).toBe("Synthetic inventory. Simulated handoff only.");
  expect(before.calls[0].verification?.source).toBe("fixture");

  await stub.runFixture("workflow");
  const receipt = (await readState(env.DB)).state.receipts.find(
    (entry): boolean => "result" in entry && "agreementId" in entry.result && "cancellationReadback" in entry.result,
  )!;

  await transact(env.DB, (state): void => {
    const saved = state.receipts.find((entry): boolean => entry.id === receipt.id)!;

    if (!("result" in saved)) {
      throw new Error("Expected a successful saved agreement");
    }

    Object.assign(saved.result, { handoff: "simulated" });
  });

  const fingerprint: { name: string; arguments: unknown } = JSON.parse(receipt.fingerprint);
  const invocationId = receipt.id.slice(context.callId.length + 1);

  await transact(env.DB, (state): void => {
    const session = state.liveSessions[0];
    session.submittedCallIds = session.submittedCallIds.filter((entry): boolean => entry !== invocationId);
  });

  await stub.observeFixture(createFunctionEvent(fingerprint.name, fingerprint.arguments, invocationId));
  expect((await stub.getFixtureOutput()).at(-2)?.json).not.toContain("simulated");
  expect((await readState(env.DB)).state.receipts.find((entry): boolean => entry.id === receipt.id)).toMatchObject({
    result: { handoff: "simulated" },
  });
});

it("sends provider closure after the goodbye window and waits for final usage before releasing the socket", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const pair = new WebSocketPair();
    const provider = pair[0];
    provider.accept();
    const messages: { type: string }[] = [];
    provider.addEventListener("message", (event): void => {
      messages.push(JSON.parse(String(event.data)));
    });

    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith("/attach")) {
        return new Response(null, { status: 101, webSocket: pair[1] });
      }

      return Response.json({ session: { id: "provider-farewell" }, transport: { sdp: "provider-answer" } });
    });

    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      provider.send(JSON.stringify(createFunctionEvent("end_call", {}, "provider-end", "provider-delegation")));
      await expect.poll(async (): Promise<string> => (await queryLiveStatus(env.DB, context)).state).toBe("ending");
      await expect
        .poll((): number => messages.filter((event): boolean => event.type === "response.create").length)
        .toBe(1);
      expect(messages.some((event): boolean => event.type === "session.close")).toBe(false);
      const farewell = (await readState(env.DB)).state.liveSessions[0].farewell!;
      vi.setSystemTime(Date.parse(farewell.deadline));
      await coordinator.alarm();
      await expect.poll((): boolean => messages.some((event): boolean => event.type === "session.close")).toBe(true);
      expect(provider.readyState).toBe(WebSocket.OPEN);
      expect((await queryLiveStatus(env.DB, context)).state).toBe("ending");
      expect((await readState(env.DB)).state.reservations[0].settled).toBe(false);
      provider.send(
        JSON.stringify({
          type: "session.closed",
          event_id: "provider-closed",
          reason: "close_requested",
          usage: { seconds: 4 },
        }),
      );
      await expect.poll(async (): Promise<string> => (await queryLiveStatus(env.DB, context)).state).toBe("ended");
      const { state } = await readState(env.DB);
      expect(state.liveSessions[0]).toMatchObject({ providerClosed: true, usageConfirmed: true, voiceSeconds: 4 });
      expect(state.reservations[0].settled).toBe(true);
      expect((await queryCall(env.DB, context)).connection).toBe("Ended normally");
    } finally {
      request.mockRestore();
      vi.useRealTimers();
      provider.close();
    }
  });
});

it("recovers a reservation abandoned before Durable Object startup without charging a provider", async (): Promise<void> => {
  const now = Date.now();
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), new Date(now - 60_000).toISOString());
  const context = { callId: id, userId: "reviewer" };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));
  await stub.recover(context);
  expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
  const { state } = await readState(env.DB);
  expect(state.reservations[0]).toMatchObject({ settled: true, chargedMicrodollars: 0 });
  expect(state.liveSessions[0].providerAttempted).toBe(false);
  expect(state.analysis).toHaveLength(1);
  expect(await queryCall(env.DB, context)).toMatchObject({
    connection: "Connection failed",
    transcript: { complete: false },
  });
});

it("keeps missing transcript and delegated usage unknown after reattaching an ended provider", async (): Promise<void> => {
  const { context, stub } = await openCall();
  await stub.end();
  await transact(env.DB, (state): void => {
    state.liveSessions[0].providerClosed = false;
    state.liveSessions[0].usageConfirmed = false;
    state.liveSessions[0].providerId = "provider-recovery";
    state.reservations[0].settled = false;
    state.calls[0].record.transcript.complete = false;
  });

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const pair = new WebSocketPair();
    const provider = pair[0];
    provider.accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 101, webSocket: pair[1] }));
    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.recover(context);
      const seconds = (await readState(env.DB)).state.liveSessions[0].voiceSeconds;
      provider.send(JSON.stringify({ type: "session.closed", event_id: "recovered-close", usage: { seconds } }));
      await expect
        .poll(async (): Promise<boolean> => (await readState(env.DB)).state.liveSessions[0].providerClosed)
        .toBe(true);
      const { state } = await readState(env.DB);
      expect(state.liveSessions[0]).toMatchObject({ gap: true, accountingGap: true });
      expect(state.calls[0].record.transcript.complete).toBe(false);
      expect(state.reservations[0].settled).toBe(false);
    } finally {
      request.mockRestore();
      provider.close();
    }
  });
});
