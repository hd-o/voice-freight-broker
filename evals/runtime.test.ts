import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { bundleWorkers, EvaluationRuntime, migrateDatabase, runScenario, requestScenario } from "./runtime.ts";
import { scenarios } from "./cases.ts";
import { scoreWorkflow, scoreSentiment } from "./scoring.ts";
import type { AnalysisInput } from "../packages/backend/src/analysis";
import { runEvaluation } from "./evaluation.ts";
import { createEvaluationTests, scoreEvaluation } from "./suites.ts";

let runtime: EvaluationRuntime;
let directory: string;
let confirmationRejections = 0;

type Message = { role?: string; content?: string; type?: string; name?: string; output?: string };

function createResponse(output: object[]): Response {
  return Response.json({
    id: randomUUID(),
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    service_tier: "priority",
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 },
    },
    output,
  });
}

function createMessage(text: string): Response {
  return createResponse([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]);
}

function createFunction(name: string, argumentsData: object): Response {
  return createResponse([
    { type: "function_call", call_id: randomUUID(), name, arguments: JSON.stringify(argumentsData) },
  ]);
}

// This transport tests the provider plumbing without paid inference. Live suite
// execution always uses fetch; it never selects these recorded tool choices.
const transport: typeof fetch = async (url, options): Promise<Response> => {
  assert.equal(typeof options?.body, "string");
  const body = JSON.parse(options!.body as string) as {
    input: string | Message[];
    text?: object;
    service_tier?: string;
  };

  if (typeof url === "string" && url.endsWith("/decisions")) {
    if (body.input === "uncertain-decisions-usage") {
      return Response.json({ usage: { input_tokens: 1000 } });
    }

    const answer = (name: string, choice: string, choices: string[], probability = 1): object => ({
      name,
      type: "choice",
      choice,
      confidence: 1,
      probabilities: choices.map((value): object => ({
        value,
        probability: value === choice ? probability : (1 - probability) / (choices.length - 1),
      })),
    });
    const probability = confirmationRejections ? 0.6 : 1;
    confirmationRejections = Math.max(0, confirmationRejections - 1);
    return Response.json(
      {
        model: "gpt-6-luna",
        answers: [
          answer("readback_accuracy", "matches", ["matches", "mismatch", "incomplete"], probability),
          answer("caller_intent", "accept", ["accept", "decline", "request_change", "unclear"]),
        ],
        usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
      },
      { headers: { "x-request-id": randomUUID() } },
    );
  }

  if (body.text) {
    assert.equal(typeof body.input, "string");
    const input = JSON.parse(body.input as string) as {
      transcript: { entries: { id: string; speaker: string }[] };
      call: { agreements: object[] };
    };
    const sentiment = input.call.agreements.length
      ? "Positive"
      : input.transcript.entries.some((entry): boolean => entry.speaker === "carrier")
        ? "Negative"
        : "Unknown";
    const output = {
      summary: input.call.agreements.length
        ? "One simulated agreement was confirmed at $2,000."
        : "No agreements were verified in the saved facts.",
      sentiment,
      evidenceIds: input.transcript.entries.slice(0, 12).map((entry): string => entry.id),
    };
    return createMessage(JSON.stringify(output));
  }

  const conversation = body.input as Message[];
  assert.equal(body.service_tier, "priority");
  const last = conversation.at(-1)!;

  if (last.type === "function_call_output") {
    const name = conversation.at(-2)?.name;
    const output = JSON.parse(last.output!) as { readback?: string; error?: object };

    if (name === "confirm_handoff" && output.error) {
      const quote = conversation
        .filter((entry): boolean => entry.type === "function_call_output")
        .map((entry): { readback?: string } => JSON.parse(entry.output!))
        .findLast((entry): boolean => !!entry.readback)!;
      return createMessage(quote.readback!);
    }

    if (name === "verify_carrier") {
      return createFunction("search_loads", { reference: "NS-seed-v1-01" });
    }

    if (name === "select_load") {
      return createMessage(output.readback!);
    }

    return createMessage(
      name === "end_call"
        ? "Thank you for calling. Goodbye."
        : name === "confirm_handoff"
          ? "The agreement is confirmed. Do you need another load?"
          : "Dallas to Atlanta dry van, posted at $2,000. Would you like it?",
    );
  }

  const text = String(last.content);

  if (text.includes("My MC")) {
    return createFunction("verify_carrier", { mcNumber: "123456" });
  }

  if (text.includes("I choose")) {
    return createFunction("select_load", { loadId: "seed-v1-01" });
  }

  if (text.includes("Yes, I confirm")) {
    const quote = conversation
      .filter((entry): boolean => entry.type === "function_call_output")
      .map((entry): { quoteId?: string } => JSON.parse(entry.output!))
      .findLast((entry): boolean => !!entry.quoteId)!;
    return createFunction("confirm_handoff", { quoteId: quote.quoteId });
  }

  return createFunction("end_call", {});
};

before(async (): Promise<void> => {
  directory = await mkdtemp(join(tmpdir(), "freight-evaluations-"));
  runtime = new EvaluationRuntime(await bundleWorkers(), "test-only-credential", { storagePath: directory, transport });
  await migrateDatabase(runtime.ledger);
});

after(async (): Promise<void> => {
  await runtime?.dispose();
  await rm(directory, { recursive: true, force: true });
});

void test("runs model-selected tools through Cloudflare RPC, saves observed evidence, analyzes saved facts, and charges the shared ledger", async (): Promise<void> => {
  const result = await runScenario(runtime, scenarios[0]);
  assert.equal(result.error, undefined);
  assert.deepEqual(scoreWorkflow(result, scenarios[0]).failures, []);
  assert.equal(scoreSentiment(result, scenarios[0]).pass, true);
  assert.equal(result.state.agreements.length, 1);
  assert.ok(result.state.confirmations.some((entry): boolean => entry.status === "applied"));
  assert.ok(result.usage.some((entry): boolean => entry.path.endsWith("decisions")));
  assert.ok(result.usage.some((entry): boolean => entry.serviceTier === "priority"));
  assert.equal(result.usage[0].costMicrodollars, 300);
  const database = await runtime.ledger.getD1Database("DB");
  const usage = await database.prepare("SELECT data FROM providerUsage").all<{ data: string }>();
  assert.equal(usage.results.length, result.usage.length);
  assert.ok(usage.results.every((entry): boolean => JSON.parse(entry.data).costMicrodollars > 0));
  const corrupted = structuredClone(result);
  corrupted.state.agreements[0].rateCents++;
  assert.equal(scoreWorkflow(corrupted, scenarios[0]).pass, false);
  const offers = structuredClone(result);
  (offers.analyses[0].input as AnalysisInput).transcript.entries[0].text += " I tried $2,700.";
  offers.state.analysis[0].result!.summary =
    "The carrier tried $2,700, but the broker did not evaluate it. The effective agreement is $2,000.";
  assert.equal(scoreWorkflow(offers, scenarios[0]).pass, true);
  offers.state.analysis[0].result!.summary = "The effective agreement was confirmed at $2,700.";
  assert.equal(scoreWorkflow(offers, scenarios[0]).pass, false);
  offers.state.analysis[0].result!.summary = "The carrier offered $3,000.";
  assert.equal(scoreWorkflow(offers, scenarios[0]).pass, false);
});

void test("uses one scripted caller clarification after rejected confirmation, with fresh observed speech and no forced tools", async (): Promise<void> => {
  confirmationRejections = 1;
  const scenario = {
    ...scenarios[0],
    confirmationRecoveries: { 2: "Yes, I confirm all those terms. Please save the agreement." },
  };
  const result = await runScenario(runtime, scenario);
  assert.deepEqual(scoreWorkflow(result, scenario).failures, []);
  assert.deepEqual(
    result.state.confirmations.map((entry): string => entry.status),
    ["rejected", "applied"],
  );
  assert.equal(result.tools.filter((entry): boolean => entry.name === "confirm_handoff").length, 2);
  const source = result.analyses[0].input as { call: { outcome: string; loads: { spokenLabel: string }[] } };
  assert.equal(source.call.outcome, "Agreement reached");
  assert.match(source.call.loads[0].spokenLabel, /9:00 AM Central Standard Time/);
});

void test("isolates analysis fixtures, preserves conflicting evidence, and requires Unknown without caller speech", async (): Promise<void> => {
  for (const scenario of scenarios.slice(8)) {
    const result = await runScenario(runtime, scenario);
    assert.equal(result.error, undefined);
    assert.deepEqual(scoreWorkflow(result, scenario).failures, []);
    assert.equal(scoreSentiment(result, scenario).pass, true);
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.state.agreements, []);
    assert.equal(result.state.calls.length, 1);

    if (scenario.id === "09-conflicting-evidence") {
      const claims = structuredClone(result);
      claims.state.analysis[0].result!.summary = "Three loads were booked at $9,999 each.";
      assert.equal(scoreWorkflow(claims, scenario).pass, false);
      claims.state.analysis[0].result!.summary =
        "The broker claimed three loads were booked at $9,999 each, but verified call facts show no loads or agreements.";
      assert.equal(scoreWorkflow(claims, scenario).pass, true);
      claims.state.analysis[0].result!.summary += " Three loads were booked at $9,999 each.";
      assert.equal(scoreWorkflow(claims, scenario).pass, false);
      claims.state.analysis[0].result!.summary =
        "The broker claimed three loads were booked at $9,999 each, but verified call facts show no loads or agreements. The final rate was $3,000.";
      assert.equal(scoreWorkflow(claims, scenario).pass, false);
    }
  }
});

void test("runs both suites in Promptfoo and exposes false approvals and provider errors as failures", async (): Promise<void> => {
  const tests = createEvaluationTests("all");
  assert.equal(tests.filter((entry): boolean => entry.vars?.suite === "workflows").length, scenarios.length);
  assert.equal(createEvaluationTests("confirmations", "dallas-fragmented").length, 4);
  const progress: number[] = [];
  const { report, path } = await runEvaluation(runtime, {
    suite: "all",
    directory: join(directory, "results"),
    writeLatestResults: false,
    tests: [
      ...createEvaluationTests("workflows", "01"),
      ...createEvaluationTests("confirmations", "dallas-fragmented-acceptance"),
      ...createEvaluationTests("confirmations", "dallas-fragmented-wrong-rate"),
    ],
    progress: (completed): void => {
      progress.push(completed);
    },
  });

  assert.equal(report.cases, 3);
  assert.equal(report.completed, 3);
  assert.equal(report.passed, 2);
  assert.equal(report.errors, 0);
  assert.equal(report.suites.confirmations.falseApprovals, 1);
  assert.ok(progress.includes(3));
  assert.equal(await readFile(path, "utf8"), `${JSON.stringify(report, null, 2)}\n`);

  const results = report.results;
  assert.equal(results.length, 3);
  assert.equal(results[0].assertions.Workflow.pass, true);
  assert.equal(results[1].assertions.Approval.pass, true);
  // The canned transport always approves: Promptfoo must flag a wrong rate.
  assert.equal(results[2].assertions.Approval.pass, false);
  assert.equal(results[2].assertions.Readback.pass, false);
  assert.equal(results[2].assertions.Intent.pass, true);
  const confirmation = results[1].result;
  assert.ok("fixtureId" in confirmation);
  assert.equal(confirmation.usage.length, 1);
  assert.ok(confirmation.usage.every((entry): boolean => !entry.unresolved));
  assert.ok(confirmation.input?.fragments.some((entry): boolean => entry.text === "0."));
  assert.equal(JSON.stringify(confirmation).includes("expectedApproval"), false);
  const failure = scoreEvaluation({
    ...confirmation,
    fixtureId: "dallas-fragmented-wrong-rate",
    approval: false,
    outcome: { status: "failed", reason: "timeout", usage: null, latencyMs: 0 },
  });
  assert.ok(Object.values(failure.assertions).every((entry): boolean => !entry.pass));
});

void test("retains unknown usage, rejects paid replay, and enforces the existing monthly allowance", async (): Promise<void> => {
  const database = await runtime.ledger.getD1Database("DB");
  await runtime.requestProvider(
    "https://api.openai.com/v1/decisions",
    { model: "gpt-6-luna", input: "uncertain-decisions-usage" },
    new AbortController().signal,
  );
  const uncertain = runtime.usage.at(-1)!;
  assert.equal(uncertain.unresolved, true);
  const pending = await database
    .prepare("SELECT data FROM reservations WHERE id = ?")
    .bind(uncertain.id)
    .first<{ data: string }>();
  assert.equal(JSON.parse(pending!.data).settled, false);
  const id = `evaluation-test:${randomUUID()}`;
  const reserve = {
    action: "reserve",
    id,
    runId: runtime.runId,
    path: "/v1/responses",
    body: { model: "gpt-6-luna", max_output_tokens: 2048 },
  };
  await runtime.requestLedger(reserve);
  await assert.rejects(runtime.requestLedger(reserve), /replayed/);
  const saved = await database.prepare("SELECT data FROM reservations WHERE id = ?").bind(id).first<{ data: string }>();
  assert.equal(JSON.parse(saved!.data).settled, false);
  const period = new Date().toISOString().slice(0, 7);
  await database
    .prepare("INSERT INTO spendingPeriods (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
    .bind(period, JSON.stringify({ id: period, spentMicrodollars: 25000000 }))
    .run();
  await assert.rejects(runtime.requestLedger({ ...reserve, id: randomUUID() }), /shared monthly allowance/);
});

void test("rejects invalid model-selected end_call arguments without finalizing the saved call", async (): Promise<void> => {
  const worker = runtime.createScenario(new AbortController().signal);

  try {
    await migrateDatabase(worker, "scenario");
    await requestScenario(worker, { action: "prepare" });
    const { id: callId } = await requestScenario<{ id: string }>(worker, { action: "start" });
    const response = await requestScenario(worker, {
      action: "tool",
      callId,
      name: "end_call",
      arguments: { unexpected: true },
      invocationId: randomUUID(),
    });
    assert.deepEqual(response, {
      error: { code: "invalid_input", message: "The call was not ended because the tool arguments are invalid." },
    });
    const state = await requestScenario<{ calls: { finalSnapshot: unknown }[] }>(worker, { action: "state" });
    assert.equal(state.calls[0].finalSnapshot, null);
  } finally {
    await worker.dispose();
  }
});
