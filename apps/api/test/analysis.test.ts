import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { createCall, finalizeCall } from "@voice-freight/backend/calls";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { readState, transact } from "@voice-freight/backend/repository";
import { queryCall, queryDashboard } from "@voice-freight/backend/reporting";
import {
  processAnalysis,
  publishAnalysis,
  retryAnalysis,
  recordDeadLetter,
  analysisReservationMicrodollars,
  type AnalysisInput,
  type AnalysisResponse,
} from "@voice-freight/backend/analysis";
import { generateAnalysis } from "@voice-freight/backend/analysis-provider";
import { sanitizeTelemetry } from "@voice-freight/backend/telemetry";
import { calculateAvailableMicrodollars, monthlyLimitMicrodollars } from "@voice-freight/backend/spending";

const clock = "2026-11-16T12:00:00.000Z";
const retryClock = "2026-11-16T12:01:00.000Z";
const finalClock = "2026-11-16T12:02:00.000Z";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

async function prepareCall(): Promise<{ callId: string; version: number }> {
  const { id } = await createCall(env.DB, "reviewer", clock);
  await transact(env.DB, (state): void => {
    state.calls[0].record.transcript.entries.push({
      id: "caller-1",
      speaker: "carrier",
      offsetSeconds: 1,
      text: "Thank you, that works for me.",
    });
  });
  await finalizeCall(
    env.DB,
    { callId: id, userId: "reviewer" },
    { connection: "Interrupted", transcriptComplete: false },
    clock,
  );
  return { callId: id, version: 1 };
}

async function respond(input: AnalysisInput, attemptId: string): Promise<AnalysisResponse> {
  return {
    id: `response-${attemptId}`,
    createdAt: clock,
    usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100 },
    output: {
      summary: "The partial call ended without an agreement.",
      sentiment: "Positive",
      evidenceIds: input.transcript.entries.map((entry): string => entry.id),
    },
  };
}

it("claims once on concurrent delivery, settles one response, and projects analysis without changing final facts", async (): Promise<void> => {
  const job = await prepareCall();
  const before = (await readState(env.DB)).state.calls[0].finalSnapshot;
  const provider = vi.fn(respond);
  await Promise.all([processAnalysis(env.DB, job, provider, clock), processAnalysis(env.DB, job, provider, clock)]);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await processAnalysis(env.DB, job, provider, retryClock)).toBe("ack");
  expect(provider).toHaveBeenCalledTimes(1);
  const { state } = await readState(env.DB);
  expect(state.calls[0].finalSnapshot).toEqual(before);
  expect(state.analysis).toHaveLength(1);
  expect(state.analysis[0]).toMatchObject({
    status: "complete",
    attempts: 1,
    model: "gpt-6-luna",
    promptVersion: "call-analysis-v4",
  });
  expect(state.reservations[0]).toMatchObject({ kind: "analysis", settled: true, chargedMicrodollars: 141 });
  expect(state.spendingPeriods[0].spentMicrodollars).toBe(141);
  const call = await queryCall(env.DB, { callId: job.callId, userId: "reviewer" });
  expect(call).toMatchObject({
    analysis: { status: "complete", sentiment: "Positive", version: 1 },
    transcript: { complete: false },
  });
  expect(
    (await queryDashboard(env.DB, "reviewer")).report.sentiments.find((item): boolean => item.label === "Positive")
      ?.count,
  ).toBe(1);
  await expect(queryCall(env.DB, { callId: job.callId, userId: "reviewer-two" })).rejects.toMatchObject({
    code: "call_unavailable",
  });
});

it("recovers interrupted publication after its lease and acknowledges completed jobs", async (): Promise<void> => {
  const job = await prepareCall();
  const send = vi.fn(async (): Promise<void> => {
    throw new Error("Queue unavailable");
  });
  await expect(publishAnalysis(env.DB, { send }, clock)).rejects.toThrow();
  send.mockResolvedValue(undefined);
  await publishAnalysis(env.DB, { send }, retryClock);
  expect(send).toHaveBeenCalledTimes(1);
  await publishAnalysis(env.DB, { send }, finalClock);
  expect(send).toHaveBeenCalledTimes(2);
  expect(send).toHaveBeenLastCalledWith(job);
  await processAnalysis(env.DB, job, respond, finalClock);
  await publishAnalysis(env.DB, { send }, "2026-11-16T13:00:00.000Z");
  expect(send).toHaveBeenCalledTimes(2);
});

it("charges failed outputs and each retry, dead-letters exhaustion, and retries the same record as administrator", async (): Promise<void> => {
  const job = await prepareCall();
  const provider = vi.fn(async (input: AnalysisInput, attemptId: string): Promise<AnalysisResponse> => ({
    ...(await respond(input, attemptId)),
    output: { inventedBooking: true },
  }));
  expect(await processAnalysis(env.DB, job, provider, clock)).toBe("retry");
  await processAnalysis(env.DB, job, provider, clock);
  expect(provider).toHaveBeenCalledTimes(1);
  await processAnalysis(env.DB, job, provider, retryClock);
  expect(await processAnalysis(env.DB, job, provider, finalClock)).toBe("dead-letter");
  await recordDeadLetter(env.DB, job);
  expect((await readState(env.DB)).state.analysis[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect((await readState(env.DB)).state.spendingPeriods[0].spentMicrodollars).toBe(423);
  await expect(retryAnalysis(env.DB, { callId: job.callId, userId: "reviewer" }, 1)).rejects.toMatchObject({
    code: "forbidden",
  });
  const retried = await retryAnalysis(env.DB, { callId: job.callId, userId: "administrator" }, 1);
  expect(await retryAnalysis(env.DB, { callId: job.callId, userId: "administrator" }, 1)).toEqual(retried);
  await recordDeadLetter(env.DB, job);
  expect(await processAnalysis(env.DB, job, provider, finalClock)).toBe("ack");
  await processAnalysis(env.DB, retried, respond, finalClock);
  const { state } = await readState(env.DB);
  expect(state.analysis).toHaveLength(1);
  expect(state.analysis[0]).toMatchObject({ status: "complete", version: 2, attempts: 4 });
  expect(state.reservations).toHaveLength(4);
  expect(state.reservations.every((entry): boolean => entry.settled)).toBe(true);
});

it("defers without a paid request when funds cannot fit and resumes after UTC renewal", async (): Promise<void> => {
  const job = await prepareCall();
  await transact(env.DB, (state): void => {
    state.spendingPeriods.push({ id: "2026-11", spentMicrodollars: monthlyLimitMicrodollars });
  });
  const provider = vi.fn(respond);
  expect(await processAnalysis(env.DB, job, provider, clock)).toBe("ack");
  expect(provider).not.toHaveBeenCalled();
  expect((await queryCall(env.DB, { callId: job.callId, userId: "reviewer" })).analysis).toMatchObject({
    status: "pending",
    reason: "allowance",
    retryAt: "2026-12-01T00:00:00.000Z",
  });
  await recordDeadLetter(env.DB, job);
  const send = vi.fn(async (): Promise<void> => {});
  await publishAnalysis(env.DB, { send }, "2026-11-30T23:59:59.000Z");
  expect(send).not.toHaveBeenCalled();
  await publishAnalysis(env.DB, { send }, "2026-12-01T00:00:00.000Z");
  expect(send).toHaveBeenCalledWith(job);
  await processAnalysis(env.DB, job, provider, "2026-12-01T00:00:00.000Z");
  expect(provider).toHaveBeenCalledTimes(1);
  expect((await readState(env.DB)).state.analysis[0].status).toBe("complete");
});

it("keeps uncertain crash reservations and recovers the expired processing lease", async (): Promise<void> => {
  const job = await prepareCall();
  await processAnalysis(
    env.DB,
    job,
    async (): Promise<AnalysisResponse> => {
      throw new Error("secret transcript token");
    },
    clock,
  );
  await transact(env.DB, (state): void => {
    const analysis = state.analysis[0];
    delete analysis.history![0].finishedAt;
    delete analysis.nextAttemptAt;
    analysis.reason = "processing";
  });
  const provider = vi.fn(respond);
  await processAnalysis(env.DB, job, provider, retryClock);
  expect(provider).not.toHaveBeenCalled();
  await publishAnalysis(env.DB, { send: async (): Promise<void> => {} }, finalClock);
  await processAnalysis(env.DB, job, provider, "2026-11-16T12:03:00.000Z");
  const { state } = await readState(env.DB);
  expect(state.reservations[0].settled).toBe(false);
  expect(state.reservations[1].settled).toBe(true);
  expect(calculateAvailableMicrodollars(state, clock)).toBe(
    monthlyLimitMicrodollars - analysisReservationMicrodollars - 141,
  );
  expect(JSON.stringify(state.analysis)).not.toContain("secret transcript");
});

it("uses Unknown without caller evidence", async (): Promise<void> => {
  const job = await prepareCall();
  await transact(env.DB, (state): void => {
    state.calls[0].record.transcript.entries = [];
  });
  await processAnalysis(
    env.DB,
    job,
    async (input, id): Promise<AnalysisResponse> => ({
      ...(await respond(input, id)),
      output: { summary: "Invented success", sentiment: "Positive", evidenceIds: [] },
    }),
    clock,
  );
  expect((await queryCall(env.DB, { callId: job.callId, userId: "reviewer" })).analysis).toMatchObject({
    sentiment: "Unknown",
    summary: expect.stringContaining("No transcript"),
  });
});

it("preserves usage for refusals and malformed model output through the real provider adapter", async (): Promise<void> => {
  const job = await prepareCall();
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      id: "provider-result",
      created_at: Date.parse(clock) / 1000,
      status: "completed",
      usage: { input_tokens: 1000, output_tokens: 100 },
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Unavailable" }] }],
    }),
  );
  try {
    await processAnalysis(
      env.DB,
      job,
      (input, id) => generateAnalysis(input, id, { OPENAI_API_KEY: "test-key" }),
      clock,
    );
    expect((await readState(env.DB)).state.reservations[0]).toMatchObject({ settled: true, chargedMicrodollars: 150 });
    expect((await readState(env.DB)).state.analysis[0].status).toBe("pending");
    const payload = request.mock.calls[0][1]?.body;
    if (typeof payload !== "string") {
      throw new Error("Expected JSON request");
    }
    const body: { max_output_tokens: number; store: boolean; input: string } = JSON.parse(payload);
    expect(body).toMatchObject({ max_output_tokens: 2048, store: false });
    expect(body.input).not.toContain("maximumCents");
  } finally {
    request.mockRestore();
  }
});

it("allowlists telemetry and excludes credentials, emails, transcripts, arbitrary errors and private ceilings", (): void => {
  expect(
    sanitizeTelemetry({
      callId: crypto.randomUUID(),
      function: "evaluate_offer",
      rateCents: 210000,
      maximumCents: 220000,
      token: "sk-test-secret",
      transcript: "private speech",
      email: "reviewer@example.test",
      error: new Error("private speech"),
      status: "reviewer@example.test",
      code: "secret",
      input: { text: "speech" },
    }),
  ).toEqual({ callId: expect.any(String), function: "evaluate_offer", rateCents: 210000, truncated: false });
  expect(sanitizeTelemetry({ callId: "sk-test-secret", invocationId: "reviewer@example.test" })).toEqual({
    truncated: false,
  });
  expect(
    sanitizeTelemetry(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, "private"]))),
  ).toEqual({ truncated: true });
});

it("requires administrator authorization for REST retry", async (): Promise<void> => {
  const job = await prepareCall();
  await recordDeadLetter(env.DB, job);
  const session = await SELF.fetch("https://example.test/api/session", {
    method: "POST",
    headers: { origin: "https://example.test", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "reviewer" }),
  });
  const response = await SELF.fetch(`https://example.test/api/calls/${job.callId}/analysis/retry`, {
    method: "POST",
    headers: {
      origin: "https://example.test",
      "Content-Type": "application/json",
      cookie: session.headers.get("set-cookie")!.split(";")[0],
    },
    body: JSON.stringify({ version: 1 }),
  });
  expect(response.status).toBe(403);
});

it("atomically reserves the last available analysis allowance across competing jobs", async (): Promise<void> => {
  const first = await prepareCall();
  const { id } = await createCall(env.DB, "reviewer-two", clock);
  await finalizeCall(
    env.DB,
    { callId: id, userId: "reviewer-two" },
    { connection: "Ended normally", transcriptComplete: true },
    clock,
  );
  await transact(env.DB, (state): void => {
    state.spendingPeriods.push({
      id: "2026-11",
      spentMicrodollars: monthlyLimitMicrodollars - analysisReservationMicrodollars,
    });
  });
  const provider = vi.fn(respond);
  await Promise.all([
    processAnalysis(env.DB, first, provider, clock),
    processAnalysis(env.DB, { callId: id, version: 1 }, provider, clock),
  ]);
  expect(provider).toHaveBeenCalledTimes(1);
  const { state } = await readState(env.DB);
  expect(state.reservations).toHaveLength(1);
  expect(state.analysis.map((entry): string | undefined => entry.reason)).toContain("allowance");
  expect(calculateAvailableMicrodollars(state, clock)).toBe(analysisReservationMicrodollars - 141);
});

it("rejects fabricated transcript evidence without changing agreement facts", async (): Promise<void> => {
  const job = await prepareCall();
  await processAnalysis(
    env.DB,
    job,
    async (input, id): Promise<AnalysisResponse> => ({
      ...(await respond(input, id)),
      output: { summary: "Unsupported", sentiment: "Positive", evidenceIds: ["invented"] },
    }),
    clock,
  );
  const { state } = await readState(env.DB);
  expect(state.analysis[0]).toMatchObject({ status: "pending", error: "invalid_output" });
  expect(state.reservations[0].settled).toBe(true);
  expect(state.calls[0].finalSnapshot?.agreements).toEqual([]);
});

it("keeps committed business behavior independent of telemetry emission failures", async (): Promise<void> => {
  const { observeOperation } = await import("@voice-freight/backend/telemetry");
  const output = vi.spyOn(console, "log").mockImplementation((): void => {
    throw new Error("Exporter unavailable");
  });
  try {
    expect(
      await observeOperation({ function: "analysis", transcript: "private" }, async (): Promise<string> => "committed"),
    ).toBe("committed");
  } finally {
    output.mockRestore();
  }
});

it("releases proven zero-usage reservations when provider configuration fails before a request", async (): Promise<void> => {
  const job = await prepareCall();
  const request = vi.spyOn(globalThis, "fetch");
  try {
    await processAnalysis(env.DB, job, (input, id) => generateAnalysis(input, id, {}), clock);
    await processAnalysis(
      env.DB,
      job,
      (input, id) => generateAnalysis(input, id, { OPENAI_API_KEY: "test-key", ANALYSIS_MODEL: "unpriced-model" }),
      retryClock,
    );
    expect(request).not.toHaveBeenCalled();
    const { state } = await readState(env.DB);
    expect(state.reservations).toHaveLength(2);
    expect(state.reservations.every((entry): boolean => entry.settled && entry.chargedMicrodollars === 0)).toBe(true);
    expect(calculateAvailableMicrodollars(state, clock)).toBe(monthlyLimitMicrodollars);
    expect(state.analysis[0].error).toBe("provider_unavailable");
  } finally {
    request.mockRestore();
  }
});

it("settles a late preflight result without changing a newer completed analysis generation", async (): Promise<void> => {
  const job = await prepareCall();
  let release: ((response: AnalysisResponse) => void) | undefined;
  const pending = processAnalysis(
    env.DB,
    job,
    () =>
      new Promise<AnalysisResponse>((resolve): void => {
        release = resolve;
      }),
    clock,
  );
  await expect.poll((): boolean => !!release).toBe(true);
  const failure = async (input: AnalysisInput, id: string): Promise<AnalysisResponse> => ({
    ...(await respond(input, id)),
    output: null,
  });
  await processAnalysis(env.DB, job, failure, finalClock);
  await processAnalysis(env.DB, job, failure, "2026-11-16T12:03:00.000Z");
  await processAnalysis(env.DB, job, failure, "2026-11-16T12:04:00.000Z");
  const retry = await retryAnalysis(env.DB, { callId: job.callId, userId: "administrator" }, 1);
  await processAnalysis(env.DB, retry, respond, "2026-11-16T12:05:00.000Z");
  release!({ status: "not_started" });
  await pending;
  const { state } = await readState(env.DB);
  expect(state.analysis[0]).toMatchObject({ version: 2, status: "complete", publication: "published" });
  expect(state.analysis[0].reason).toBeUndefined();
  expect(state.analysis[0].error).toBeUndefined();
  expect(state.reservations[0]).toMatchObject({ settled: true, chargedMicrodollars: 0 });
});
