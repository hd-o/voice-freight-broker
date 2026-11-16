import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import type { ToolResult } from "@voice-freight/backend/business";
import { executeTool } from "@voice-freight/backend/business";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { ingestProviderEvent } from "@voice-freight/backend/provider-events";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { classifyConfirmation } from "@voice-freight/backend/confirmation-provider";
import { prepareConfirmation } from "@voice-freight/backend/confirmation";
import { monthlyLimitMicrodollars } from "@voice-freight/backend/spending";
import type { CallContext } from "@voice-freight/contracts/business";
import type {
  ConfirmationInput,
  ConfirmationOutcome,
  ConfirmationProvider,
} from "@voice-freight/backend/confirmation-policy";

const clock = "2026-11-16T12:00:00.000Z";
const speechClock = "2026-11-16T11:59:58.000Z";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

function createProvider(scenario = "success"): ConfirmationProvider {
  return (input, id) =>
    classifyConfirmation(input, id, {
      ENVIRONMENT: "local",
      VOICE_PROVIDER: "stub",
      CONFIRMATION_STUB_SCENARIO: scenario,
    });
}

async function prepareCall(
  userId = "reviewer",
  loadId = "seed-v1-01",
): Promise<{ context: CallContext; quoteId: string; readback: string }> {
  const { id } = await reserveLiveCall(env.DB, userId, crypto.randomUUID(), speechClock);
  const context = { callId: id, userId };
  await executeTool(env.DB, context, "verify_carrier", { invocationId: "verify", arguments: { mcNumber: "123456" } });
  const quote = await executeTool(env.DB, context, "select_load", {
    invocationId: "select",
    arguments: { loadId },
  });

  if (!("quoteId" in quote)) {
    throw new Error("Expected quote");
  }

  return { context, quoteId: quote.quoteId, readback: quote.readback };
}

async function recordSpeech(
  context: CallContext,
  readback: string,
  caller = "Yes, that works for me.",
  startMs = 1000,
): Promise<void> {
  for (const [speaker, text, offset] of [
    ["output", readback, 0],
    ["input", caller, 1000],
  ] as const) {
    await ingestProviderEvent(
      env.DB,
      context,
      {
        type: `session.${speaker}_transcript.delta`,
        event_id: crypto.randomUUID(),
        start_ms: startMs + offset,
        end_ms: startMs + offset + 500,
        delta: text,
      },
      speechClock,
    );
  }
}

async function confirm(
  context: CallContext,
  quoteId: string,
  provider = createProvider(),
  invocationId = "confirm",
): Promise<ToolResult> {
  return executeTool(
    env.DB,
    context,
    "confirm_handoff",
    { invocationId, arguments: { quoteId } },
    clock,
    true,
    provider,
  );
}

it("replays the actual 9 a.m. regression, persists only references, and commits one $2,100 agreement", async (): Promise<void> => {
  const { context, quoteId } = await prepareCall();
  const quote = await executeTool(env.DB, context, "evaluate_offer", {
    invocationId: "price",
    arguments: { quoteId, amountCents: 240000 },
  });

  if (!("quoteId" in quote)) {
    throw new Error("Expected quote");
  }

  await recordSpeech(
    context,
    " Please confirm: Summit Transport, Dallas to Atlanta dry van, pickup November 17, 2026 at 9 a.m. Central Standard Time at 2,100 dollars. Please say, yes, confirmed.",
    " Yes, confirmed",
  );
  const provider = vi.fn(createProvider());
  const first = await confirm(context, quote.quoteId, provider);
  expect(await confirm(context, quote.quoteId, provider)).toEqual(first);
  const { state } = await readState(env.DB);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(state.agreements).toMatchObject([
    { rateCents: 210000, load: { pickupAt: "2026-11-17T15:00:00.000Z", pickupTimeZone: "America/Chicago" } },
  ]);
  expect(state.confirmationAttempts).toMatchObject([
    { status: "applied", receiptId: `${context.callId}:confirm`, chargedMicrodollars: 100 },
  ]);
  expect(JSON.stringify(state.confirmationAttempts)).not.toContain("Please confirm:");
  expect(state.evidence.every((entry): boolean => !!entry.transcriptIds?.length && !!entry.confirmationAttemptId)).toBe(
    true,
  );
  expect(provider.mock.calls[0][0].terms.localPickup).toContain("9:00:00 AM");
  expect(state.reservations.find((entry): boolean => entry.kind === "confirmation")).toMatchObject({
    settled: true,
    chargedMicrodollars: 100,
  });
});

it.each([
  ["mismatch", "evidence_required"],
  ["incomplete", "evidence_required"],
  ["decline", "confirmation_declined"],
  ["request_change", "confirmation_change"],
  ["unclear", "confirmation_unclear"],
])("recovers %s without saving an agreement", async (scenario, code): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback, "Yes, but change the rate.");
  await expect(confirm(context, quoteId, createProvider(scenario))).rejects.toMatchObject({ code });
  const { state } = await readState(env.DB);
  expect(state.agreements).toHaveLength(0);
  expect(state.confirmationAttempts[0].status).toBe("rejected");
  expect(state.reservations.find((entry): boolean => entry.kind === "confirmation")?.settled).toBe(true);
});

it("bounds conversational retries separately from provider failures and requires fresh speech", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  await expect(confirm(context, quoteId, createProvider("failure"), "outage")).rejects.toMatchObject({
    code: "confirmation_unavailable",
  });
  await recordSpeech(context, readback, "Maybe", 4000);
  await expect(confirm(context, quoteId, createProvider("unclear"), "unclear-one")).rejects.toMatchObject({
    code: "confirmation_unclear",
    message: expect.not.stringContaining("Two confirmation"),
  });
  await recordSpeech(context, readback, "Maybe", 7000);
  await expect(confirm(context, quoteId, createProvider("unclear"), "unclear-two")).rejects.toMatchObject({
    message: expect.stringContaining("Two confirmation attempts failed"),
  });
  const provider = vi.fn(createProvider());
  await expect(confirm(context, quoteId, provider, "same-speech")).rejects.toMatchObject({
    code: "confirmation_pending",
  });
  expect(provider).not.toHaveBeenCalled();
});

it("rejects low confidence despite matching categories", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  const provider: ConfirmationProvider = async (input, id): Promise<ConfirmationOutcome> => {
    const outcome = await createProvider()(input, id);
    outcome.answers!.intent.confidence = 0.2;
    return outcome;
  };
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_unclear" });
});

it("claims concurrent deliveries once, records one charge, and rejects conflicting identities", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  let release: (() => void) | undefined;
  const provider = vi.fn(async (input: ConfirmationInput, id: string): Promise<ConfirmationOutcome> => {
    await new Promise<void>((resolve): void => {
      release = resolve;
    });
    return createProvider()(input, id);
  });
  const pending = confirm(context, quoteId, provider);
  await expect.poll((): boolean => !!release).toBe(true);
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_pending" });
  await expect(confirm(context, quoteId, provider, "other-invocation")).rejects.toMatchObject({
    code: "confirmation_pending",
  });
  await expect(confirm(context, "different-target", provider)).rejects.toMatchObject({ code: "invocation_conflict" });
  release!();
  await pending;
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await readState(env.DB)).state.providerUsage).toHaveLength(1);
});

it.each(["correction", "broker", "hangup", "quote", "gap", "allocation"])(
  "rejects in-flight %s while settling paid usage",
  async (scenario): Promise<void> => {
    const { context, quoteId, readback } = await prepareCall();
    await recordSpeech(context, readback);
    const competitor = scenario === "allocation" ? await prepareCall("reviewer-two") : undefined;
    const provider: ConfirmationProvider = async (input, id): Promise<ConfirmationOutcome> => {
      if (scenario === "correction" || scenario === "broker") {
        await ingestProviderEvent(
          env.DB,
          context,
          {
            type: `session.${scenario === "broker" ? "output" : "input"}_transcript.delta`,
            event_id: "late",
            start_ms: 3000,
            end_ms: 3500,
            delta: scenario === "broker" ? "Actually the rate is different" : ", but change the date.",
          },
          clock,
        );
      } else {
        await transact(env.DB, (state): void => {
          if (scenario === "hangup") {
            state.liveSessions[0].state = "ending";
          }
          if (scenario === "gap") {
            state.liveSessions[0].gap = true;
          }
          if (scenario === "quote") {
            state.quotes[0].valid = false;
          }
          if (scenario === "allocation") {
            state.agreements.push({
              id: "other",
              callId: competitor!.context.callId,
              ownerId: "reviewer-two",
              carrierId: state.calls[0].verification!.carrierId!,
              verification: state.calls[0].verification!,
              load: state.calls[0].record.loads[0],
              rateCents: 200000,
              version: 1,
              status: "effective",
              evidence: { readbackId: "other", callerId: "other" },
            });
          }
        });
      }
      return createProvider()(input, id);
    };
    await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: expect.any(String) });
    const { state } = await readState(env.DB);
    expect(state.agreements.filter((entry): boolean => entry.callId === context.callId)).toHaveLength(0);
    expect(state.reservations.find((entry): boolean => entry.kind === "confirmation")).toMatchObject({
      settled: true,
      chargedMicrodollars: 100,
    });
  },
);

it("does not invalidate speech for unrelated ledger writes or revision retries", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  const provider = vi.fn(async (input: ConfirmationInput, id: string): Promise<ConfirmationOutcome> => {
    await transact(env.DB, (state): void => {
      state.liveSessions[0].warned = true;
    });
    return createProvider()(input, id);
  });
  await confirm(context, quoteId, provider);
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await readState(env.DB)).state.agreements).toHaveLength(1);
});

it.each(["missing", "overlap", "gap", "early", "oversize", "ownership"])(
  "rejects %s evidence before provider spending",
  async (scenario): Promise<void> => {
    const { context, quoteId, readback } = await prepareCall();
    if (scenario !== "missing") {
      await recordSpeech(context, readback, "Yes");
    }
    if (scenario === "oversize") {
      for (let index = 0; index < 4; index++) {
        await ingestProviderEvent(
          env.DB,
          context,
          {
            type: "session.input_transcript.delta",
            event_id: `long-${index}`,
            start_ms: 3000 + index * 1000,
            end_ms: 3500 + index * 1000,
            delta: "x".repeat(7000),
          },
          speechClock,
        );
      }
    }
    await transact(env.DB, (state): void => {
      if (scenario === "overlap") {
        state.transcriptFragments[1].startMs = 1100;
      }
      if (scenario === "gap") {
        state.liveSessions[0].gap = true;
      }
      if (scenario === "early") {
        state.liveSessions[0].lastInputAt = clock;
      }
    });
    const provider = vi.fn(createProvider());
    await expect(
      confirm(scenario === "ownership" ? { ...context, userId: "reviewer-two" } : context, quoteId, provider),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(provider).not.toHaveBeenCalled();
    expect((await readState(env.DB)).state.confirmationAttempts).toHaveLength(0);
  },
);

it("keeps the whole fragmented response and bargaining context, without dropping a trailing correction", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, `I cannot do $2,500. ${readback}`, "Yes, confirmed");
  await ingestProviderEvent(
    env.DB,
    context,
    {
      type: "session.input_transcript.delta",
      event_id: "correction",
      start_ms: 3000,
      end_ms: 3500,
      delta: ", but change the date.",
    },
    speechClock,
  );
  const provider = vi.fn(createProvider("request_change"));
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_change" });
  expect(provider.mock.calls[0][0].callerIds).toHaveLength(2);
  expect(provider.mock.calls[0][0].fragments.at(-1)?.text).toContain("change the date");
});

it("blocks ordinary RPC confirmation even with trusted-looking evidence", async (): Promise<void> => {
  const { context, quoteId } = await prepareCall();
  await expect(
    executeTool(env.DB, context, "confirm_handoff", {
      invocationId: "bypass",
      arguments: { quoteId, evidence: { readbackId: "fabricated", callerId: "fabricated" } },
    }),
  ).rejects.toMatchObject({ code: "confirmation_required" });
});

it("preserves uncertain reservations and never reclaims expired paid attempts", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  const provider = vi.fn(async (): Promise<ConfirmationOutcome> => {
    throw new Error("private transcript token");
  });
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_unavailable" });
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_unavailable" });
  const { state } = await readState(env.DB);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(state.reservations.find((entry): boolean => entry.kind === "confirmation")?.settled).toBe(false);
  expect(JSON.stringify(state.confirmationAttempts)).not.toContain("private transcript");
});

it("releases no-request failures and blocks exhausted allowance without a provider request", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  await expect(confirm(context, quoteId, (input, id) => classifyConfirmation(input, id, {}))).rejects.toMatchObject({
    code: "confirmation_unavailable",
  });
  expect(
    (await readState(env.DB)).state.reservations.find((entry): boolean => entry.kind === "confirmation"),
  ).toMatchObject({ settled: true, chargedMicrodollars: 0 });
  await recordSpeech(context, readback, "Yes", 4000);
  await transact(env.DB, (state): void => {
    state.spendingPeriods.push({ id: "2026-11", spentMicrodollars: monthlyLimitMicrodollars });
  });
  const provider = vi.fn(createProvider());
  await expect(confirm(context, quoteId, provider, "budget")).rejects.toMatchObject({
    code: "confirmation_unavailable",
  });
  expect(provider).not.toHaveBeenCalled();
});

it("replaces and cancels the correct version, preserving original agreements until success", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  const original = await confirm(context, quoteId);
  if (!("agreementId" in original)) {
    throw new Error("Expected agreement");
  }
  const quote = await executeTool(env.DB, context, "begin_renegotiation", {
    invocationId: "replace",
    arguments: { agreementId: original.agreementId },
  });
  if (!("quoteId" in quote)) {
    throw new Error("Expected quote");
  }
  await recordSpeech(context, quote.readback, "Yes", 4000);
  await expect(confirm(context, quote.quoteId, createProvider("failure"), "replacement-failure")).rejects.toMatchObject(
    { code: "confirmation_unavailable" },
  );
  expect((await readState(env.DB)).state.agreements[0].status).toBe("effective");
  await recordSpeech(context, quote.readback, "Yes", 7000);
  const provider = vi.fn(createProvider());
  const replacement = await confirm(context, quote.quoteId, provider, "replacement");
  expect(provider.mock.calls[0][0]).toMatchObject({
    action: "replace",
    terms: { replacementId: original.agreementId, replacementVersion: 1 },
  });
  if (!("cancellationReadback" in replacement)) {
    throw new Error("Expected agreement");
  }
  await recordSpeech(context, replacement.cancellationReadback, "Please cancel it", 10000);
  await executeTool(
    env.DB,
    context,
    "cancel_agreement",
    { invocationId: "cancel", arguments: { agreementId: replacement.agreementId } },
    clock,
    true,
    createProvider(),
  );
  expect((await readState(env.DB)).state.agreements.map((entry): string => entry.status)).toEqual([
    "superseded",
    "cancelled",
  ]);
});

it.each(["valid", "refusal", "duplicate", "invalid", "missing_usage", "timeout", "missing_access"])(
  "validates the actual provider adapter for %s",
  async (scenario): Promise<void> => {
    const { context, quoteId, readback } = await prepareCall();
    await recordSpeech(context, readback);
    const input = prepareConfirmation((await readState(env.DB)).state, context, "handoff", quoteId, clock);
    const canned = await createProvider()(input, "fixture");
    const body = {
      model: "gpt-6-luna",
      answers: [canned.answers!.readback, canned.answers!.intent],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
    };
    if (scenario === "duplicate") {
      body.answers = [canned.answers!.readback, canned.answers!.readback];
    }
    const request = vi.spyOn(globalThis, "fetch");
    if (scenario === "timeout") {
      request.mockRejectedValue(new DOMException("timeout", "TimeoutError"));
    } else if (scenario === "missing_access") {
      request.mockResolvedValue(new Response("", { status: 403 }));
    } else {
      request.mockResolvedValue(
        Response.json(
          scenario === "refusal"
            ? { ...body, answers: [{ type: "refusal", name: "readback_accuracy" }, canned.answers!.intent] }
            : scenario === "invalid"
              ? { ...body, answers: [{ ...canned.answers!.readback, confidence: 2 }, canned.answers!.intent] }
              : scenario === "missing_usage"
                ? { ...body, usage: null }
                : body,
          { headers: { "x-request-id": "request-test" } },
        ),
      );
    }
    try {
      const outcome = await classifyConfirmation(input, "test", { OPENAI_API_KEY: "test-key" });
      expect(outcome.status).toBe(
        scenario === "valid" ? "evaluated" : scenario === "missing_access" ? "not_started" : "failed",
      );
      if (["refusal", "duplicate", "invalid"].includes(scenario)) {
        expect(outcome.usage?.inputTokens).toBe(1000);
      }
      if (scenario === "missing_usage" || scenario === "timeout") {
        expect(outcome.usage).toBeNull();
      }
      const content = request.mock.calls[0][1]?.body;
      if (typeof content !== "string") {
        throw new Error("Expected JSON body");
      }
      const payload = JSON.parse(content);
      expect(payload.prompt_cache_options).toEqual({ mode: "explicit" });
      expect(payload.questions.map((entry: { name: string }): string => entry.name)).toEqual([
        "readback_accuracy",
        "caller_intent",
      ]);
      expect(JSON.stringify(payload)).not.toContain("maximumCents");
    } finally {
      request.mockRestore();
    }
  },
);

it("settles a late reply once after lease expiry without applying its agreement", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  await recordSpeech(context, readback);
  let release: (() => void) | undefined;
  const provider = vi.fn(async (input: ConfirmationInput, id: string): Promise<ConfirmationOutcome> => {
    await new Promise<void>((resolve): void => {
      release = resolve;
    });
    return createProvider()(input, id);
  });
  const pending = confirm(context, quoteId, provider);
  await expect.poll((): boolean => !!release).toBe(true);
  await expect(
    executeTool(
      env.DB,
      context,
      "confirm_handoff",
      { invocationId: "confirm", arguments: { quoteId } },
      "2026-11-16T12:00:31.000Z",
      true,
      provider,
    ),
  ).rejects.toMatchObject({ code: "confirmation_unavailable" });
  release!();
  await expect(pending).rejects.toMatchObject({ code: "confirmation_unavailable" });
  const { state } = await readState(env.DB);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(state.agreements).toHaveLength(0);
  expect(state.providerUsage).toHaveLength(1);
  expect(state.reservations.find((entry): boolean => entry.kind === "confirmation")).toMatchObject({
    settled: true,
    chargedMicrodollars: 100,
  });
});

it("replays an early invocation's failure instead of applying later speech", async (): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  const provider = vi.fn(createProvider());
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "evidence_required" });
  await recordSpeech(context, readback);
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "evidence_required" });
  expect(provider).not.toHaveBeenCalled();
  await confirm(context, quoteId, provider, "fresh");
  expect(provider).toHaveBeenCalledTimes(1);
});

it.each(["decline", "request_change", "mismatch"])(
  "clarifies low-confidence %s rather than acting on that category",
  async (scenario): Promise<void> => {
    const { context, quoteId, readback } = await prepareCall();
    await recordSpeech(context, readback);
    const provider: ConfirmationProvider = async (input, id): Promise<ConfirmationOutcome> => {
      const outcome = await createProvider(scenario)(input, id);
      if (scenario === "mismatch") {
        outcome.answers!.readback.confidence = 0.1;
      } else {
        outcome.answers!.intent.confidence = 0.1;
      }
      return outcome;
    };
    await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code: "confirmation_unclear" });
    expect((await readState(env.DB)).state.agreements).toHaveLength(0);
  },
);

it("binds evaluation replay to input, labels and inference versions while preserving its original scoring provenance", async (): Promise<void> => {
  const { evaluateConfirmation } = await import("@voice-freight/backend/confirmation-evaluations");
  const request = { runId: crypto.randomUUID(), fixtureId: "regression" };
  const provider = vi.fn(createProvider());
  const first = await evaluateConfirmation(env.DB, "administrator", request, provider);
  expect(await evaluateConfirmation(env.DB, "administrator", request, provider)).toEqual(first);
  expect(provider).toHaveBeenCalledTimes(1);
  await expect(evaluateConfirmation(env.DB, "reviewer", request, provider)).rejects.toMatchObject({
    code: "forbidden",
  });
  for (const field of ["inputHash", "fingerprint", "model", "promptVersion"] as const) {
    await transact(env.DB, (state): void => {
      state.confirmationAttempts[0][field] = "different";
    });
    await expect(evaluateConfirmation(env.DB, "administrator", request, provider)).rejects.toMatchObject({
      code: "invocation_conflict",
    });
    await transact(env.DB, (state): void => {
      state.confirmationAttempts[0][field] = first.inference[field];
    });
  }
  await transact(env.DB, (state): void => {
    state.confirmationAttempts[0].policyVersion = "previous-policy";
  });
  expect((await evaluateConfirmation(env.DB, "administrator", request, provider)).inference.policyVersion).toBe(
    "previous-policy",
  );
  expect(provider).toHaveBeenCalledTimes(1);
});

it.each([
  [
    "Please confirm: Summit Transport, Memphis to Denver reefer, pickup November 18, 2026 at 9 a.m. Central Standard Time, at two thousand fifty dollars. Do you accept these terms?",
    "One sec.",
  ],
  [
    "The agreement wasn’t saved. Please confirm: Summit Transport, Memphis to Denver reefer, pickup November 18, 2026 at 9 a.m. Central Standard Time, at 2050 dollars. Do you accept these terms?",
    "Checking.",
  ],
])(
  "keeps the Memphis confirmation when the broker follows it with %s / %s",
  async (readback, acknowledgment): Promise<void> => {
    const { context, quoteId } = await prepareCall("reviewer", "seed-v1-02");
    for (const [speaker, text, startMs, endMs] of [
      ["output", readback, 74400, 86600],
      ["input", "Yes", 90200, 90400],
      ["output", acknowledgment, 91200, 91600],
    ] as const) {
      await ingestProviderEvent(
        env.DB,
        context,
        {
          type: `session.${speaker}_transcript.delta`,
          event_id: crypto.randomUUID(),
          delta: text,
          start_ms: startMs,
          end_ms: endMs,
        },
        speechClock,
      );
    }
    const provider = vi.fn(createProvider());
    const first = await confirm(context, quoteId, provider);
    expect(await confirm(context, quoteId, provider)).toEqual(first);
    expect(provider).toHaveBeenCalledTimes(1);
    const input = provider.mock.calls[0][0];
    expect(input.fragments.map((entry): string => entry.text)).toEqual([readback, "Yes", acknowledgment]);
    expect(input.readbackIds).toEqual([input.fragments[0].id]);
    expect(input.callerIds).toEqual([input.fragments[1].id]);
    const { state } = await readState(env.DB);
    expect(state.agreements).toMatchObject([
      {
        rateCents: 205000,
        load: { id: "seed-v1-02", pickupAt: "2026-11-18T15:00:00.000Z", pickupTimeZone: "America/Chicago" },
      },
    ]);
    expect(state.confirmationAttempts).toHaveLength(1);
    expect(state.confirmationAttempts[0].evidence).toHaveLength(3);
  },
);

it.each([
  ["Actually the rate is $2,200.", "mismatch", "evidence_required"],
  ["Please confirm these terms again.", "incomplete", "evidence_required"],
  ["Checking.", "request_change", "confirmation_change"],
])("includes later broker speech in classification: %s", async (followingBroker, scenario, code): Promise<void> => {
  const { context, quoteId, readback } = await prepareCall();
  const caller = scenario === "request_change" ? "Yes, but change the rate." : "Yes";
  await recordSpeech(context, readback, caller);
  await ingestProviderEvent(
    env.DB,
    context,
    {
      type: "session.output_transcript.delta",
      event_id: "following-broker",
      start_ms: 3000,
      end_ms: 3500,
      delta: followingBroker,
    },
    speechClock,
  );
  const provider = vi.fn(createProvider(scenario));
  await expect(confirm(context, quoteId, provider)).rejects.toMatchObject({ code });
  expect(provider).toHaveBeenCalledTimes(1);
  expect(provider.mock.calls[0][0].fragments.map((entry): string => entry.text)).toEqual([
    readback,
    caller,
    followingBroker,
  ]);
  expect((await readState(env.DB)).state.agreements).toHaveLength(0);
});
