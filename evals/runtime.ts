import { build } from "esbuild";
import { Log, Miniflare, convertV4MiniflareOptions, Response as RuntimeResponse } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { State } from "../packages/backend/src/model";
import { suiteVersion, type Scenario } from "./cases.ts";
import type { ConfirmationInput, ConfirmationOutcome } from "../packages/backend/src/confirmation-policy";

export const repositoryPath = fileURLToPath(new URL("../", import.meta.url).href);
export const limits = { requests: 40, turns: 20, continuations: 4, outputTokens: 2048, scenarioMs: 300000 };

// Keep both Miniflare diagnostics and application console output away from
// stdout, which the development CLI reserves for machine-readable results.
class EvaluationLog extends Log {
  protected log(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}

const logging = {
  log: new EvaluationLog(),
  handleStructuredLogs(entry: { message: string }): void {
    process.stderr.write(`${entry.message}\n`);
  },
};

type Delegation = {
  model: string;
  instructions: string;
  reasoning: { effort: string };
  max_output_tokens: number;
  parallel_tool_calls: boolean;
  tools: object[];
  tool_choice: string;
};

export type Configuration = {
  delegation: Delegation;
  promptVersion: string;
  analysisPromptVersion: string;
  analysisInstructions: string;
  confirmationQuestions: object[];
};
export type ToolEvent = {
  callId: string;
  turn: number;
  name: string;
  arguments: Record<string, unknown>;
  result: unknown;
};
export type Snapshot = Pick<
  State,
  "agreements" | "negotiations" | "quotes" | "events" | "evidence" | "receipts" | "analysis"
> & {
  calls: (State["calls"][number] & { outcome: string })[];
  fragments: State["transcriptFragments"];
  confirmations: State["confirmationAttempts"];
};

export type EvaluationResult = {
  suiteVersion: string;
  sourceHash: string;
  scenarioId: string;
  configuration: Configuration;
  responses: unknown[];
  tools: ToolEvent[];
  checkpoints: { callId: string; turn: number; agreements: Snapshot["agreements"] }[];
  analyses: { callId: string; input?: unknown; response?: unknown; disposition: string }[];
  state: Snapshot;
  usage: {
    id: string;
    path: string;
    status: number;
    serviceTier?: string;
    costMicrodollars?: number;
    unresolved: boolean;
    settlement?: object;
  }[];
  error?: string;
};

export type ConfirmationResult = {
  suiteVersion: string;
  sourceHash: string;
  fixtureId: string;
  configuration?: Configuration;
  input?: ConfirmationInput;
  outcome?: ConfirmationOutcome;
  approval: boolean;
  usage: EvaluationResult["usage"];
  error?: string;
};

export type SuiteResult = EvaluationResult | ConfirmationResult;

export async function bundleWorkers(): Promise<{ worker: string; ledger: string }> {
  const output: Record<string, string> = {};

  for (const name of ["worker", "ledger"]) {
    const bundle = await build({
      entryPoints: [resolve(repositoryPath, `evals/${name}.ts`)],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      target: "es2023",
      external: ["cloudflare:*", "node:*"],
      logLevel: "silent",
    });
    output[name] = bundle.outputFiles[0].text;
  }

  return { worker: output.worker, ledger: output.ledger };
}

export async function migrateDatabase(runtime: Miniflare, workerName?: string): Promise<void> {
  const database = await runtime.getD1Database("DB", workerName);
  const directory = resolve(repositoryPath, "packages/backend/migrations");

  for (const name of (await readdir(directory)).filter((entry): boolean => entry.endsWith(".sql")).sort()) {
    const migration = await readFile(resolve(directory, name), "utf8");
    const statements = migration
      .split("--> statement-breakpoint")
      .map((entry): string => entry.trim())
      .filter(Boolean);
    await database.batch(statements.map((statement) => database.prepare(statement)));
  }
}

export async function readCredential(): Promise<string> {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const source = await readFile(resolve(repositoryPath, "apps/api/.dev.vars.local"), "utf8");
  const value = source.match(/^OPENAI_API_KEY\s*=\s*(.+)$/m)?.[1].trim();

  if (!value) {
    throw new Error("The reused OpenAI credential is unavailable.");
  }

  return value.replace(/^(["'])(.*)\1$/, "$2");
}

export class EvaluationRuntime {
  readonly runId = randomUUID();
  readonly sourceHash: string;
  readonly ledger: Miniflare;
  readonly worker: string;
  readonly #credential: string;
  readonly transport: typeof fetch;
  readonly usage: EvaluationResult["usage"] = [];

  constructor(
    bundles: { ledger: string; worker: string },
    credential: string,
    options: { storagePath?: string; transport?: typeof fetch } = {},
  ) {
    this.worker = bundles.worker;
    this.sourceHash = createHash("sha256").update(bundles.worker).update(bundles.ledger).digest("hex");
    this.#credential = credential;
    this.transport = options.transport ?? fetch;
    this.ledger = new Miniflare(
      convertV4MiniflareOptions({
        ...logging,
        modules: true,
        script: bundles.ledger,
        compatibilityDate: "2026-11-12",
        compatibilityFlags: ["nodejs_compat"],
        resourcePersistencePath: options.storagePath ?? resolve(repositoryPath, ".wrangler/state/v3"),
        d1Databases: { DB: "00000000-0000-0000-0000-000000000001" },
      }),
    );
  }

  async verifyLedger(): Promise<void> {
    const database = await this.ledger.getD1Database("DB");
    await database.prepare("SELECT id FROM reservations LIMIT 1").all();
  }

  async requestLedger(command: object): Promise<Record<string, unknown>> {
    const response = await this.ledger.dispatchFetch("http://ledger/", {
      method: "POST",
      body: JSON.stringify(command),
    });
    const result = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      throw new Error(String(result.error));
    }

    return result;
  }

  async requestProvider(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
    const path = new URL(url).pathname;

    if (new URL(url).origin !== "https://api.openai.com" || !["/v1/responses", "/v1/decisions"].includes(path)) {
      throw new Error("The evaluation transport rejected an unexpected provider endpoint.");
    }

    signal.throwIfAborted();
    const id = `evaluation:${this.runId}:${randomUUID()}`;
    await this.requestLedger({ action: "reserve", id, runId: this.runId, path, body });
    const usage: EvaluationResult["usage"][number] = { id, path, status: 0, unresolved: true };
    this.usage.push(usage);
    const response = await this.transport(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.#credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    });
    usage.status = response.status;
    const envelope = (await response.clone().json()) as {
      id?: string;
      created_at?: number;
      service_tier?: string;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
      };
    };
    usage.serviceTier = envelope.service_tier;
    const counters = envelope.usage;

    if (
      counters &&
      Number.isSafeInteger(counters.input_tokens) &&
      (path === "/v1/decisions"
        ? Number.isSafeInteger(counters.input_tokens_details?.cached_tokens) &&
          Number.isSafeInteger(counters.input_tokens_details?.cache_write_tokens)
        : Number.isSafeInteger(counters.output_tokens))
    ) {
      const command = {
        action: "settle",
        id,
        providerId: envelope.id ?? response.headers.get("x-request-id") ?? id,
        createdAt: envelope.created_at ? new Date(envelope.created_at * 1000).toISOString() : new Date().toISOString(),
        inputTokens: counters.input_tokens,
        cachedInputTokens: counters.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: counters.input_tokens_details?.cache_write_tokens ?? 0,
        outputTokens: counters.output_tokens ?? 0,
      };
      usage.settlement = command;
      const settlement = await this.requestLedger(command);
      usage.costMicrodollars = Number(settlement.chargedMicrodollars);
      usage.unresolved = false;
    }

    return response;
  }

  createScenario(signal: AbortSignal): Miniflare {
    const databaseId = randomUUID();
    const workerConfiguration = {
      modules: true,
      script: this.worker,
      compatibilityDate: "2026-11-12",
      compatibilityFlags: ["nodejs_compat"],
      bindings: { OPENAI_API_KEY: "evaluation-transport" },
    };
    const outboundService = async (request: import("miniflare").Request): Promise<RuntimeResponse> => {
      const response = await this.requestProvider(
        request.url,
        (await request.json()) as Record<string, unknown>,
        signal,
      );
      return new RuntimeResponse(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    };

    return new Miniflare(
      convertV4MiniflareOptions({
        ...logging,
        workers: [
          {
            ...workerConfiguration,
            name: "scenario",
            d1Databases: { DB: databaseId },
            serviceBindings: { TOOLS: { name: "tools", entrypoint: "EvaluationTools" } },
            outboundService,
          },
          {
            ...workerConfiguration,
            name: "tools",
            d1Databases: { DB: databaseId },
            serviceBindings: { CONFIRMATION_PROVIDER: { name: "confirmation", entrypoint: "EvaluationConfirmation" } },
            outboundService,
          },
          { ...workerConfiguration, name: "confirmation", outboundService },
        ],
      }),
    );
  }

  async dispose(): Promise<void> {
    await this.ledger.dispose();
  }
}

export async function requestScenario<T>(runtime: Miniflare, input: object): Promise<T> {
  const response = await runtime.dispatchFetch("http://scenario/", { method: "POST", body: JSON.stringify(input) });

  if (!response.ok) {
    throw new Error(`Evaluation adapter returned ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function runConfirmation(runtime: EvaluationRuntime, fixtureId: string): Promise<ConfirmationResult> {
  const controller = new AbortController();
  const timeout = setTimeout((): void => controller.abort(), limits.scenarioMs);
  const worker = runtime.createScenario(controller.signal);
  const usageStart = runtime.usage.length;
  const result: ConfirmationResult = {
    suiteVersion,
    sourceHash: runtime.sourceHash,
    fixtureId,
    approval: false,
    usage: [],
  };

  try {
    result.configuration = await requestScenario<Configuration>(worker, { action: "configuration" });
    const response = await requestScenario<Pick<ConfirmationResult, "input" | "outcome" | "approval">>(worker, {
      action: "confirmation-fixture",
      fixture: fixtureId,
    });
    result.input = response.input;
    result.outcome = response.outcome;
    result.approval = response.approval;
  } catch (failure) {
    result.error = failure instanceof Error ? failure.message : "Confirmation evaluation failed.";
  } finally {
    result.usage = runtime.usage.slice(usageStart);
    clearTimeout(timeout);
    controller.abort();
    await worker.dispose();
  }

  return result;
}

export async function runScenario(runtime: EvaluationRuntime, scenario: Scenario): Promise<EvaluationResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    (): void => controller.abort(new Error("Scenario exceeded its runtime bound.")),
    limits.scenarioMs,
  );
  const worker = runtime.createScenario(controller.signal);
  const usageStart = runtime.usage.length;
  const responses: unknown[] = [];
  const tools: ToolEvent[] = [];
  const checkpoints: EvaluationResult["checkpoints"] = [];
  const analyses: EvaluationResult["analyses"] = [];
  let error: string | undefined;
  let configuration: Configuration | undefined;

  try {
    await migrateDatabase(worker, "scenario");
    await requestScenario(worker, { action: "prepare" });
    configuration = await requestScenario<Configuration>(worker, { action: "configuration" });
    let count = 0;

    for (const turns of scenario.calls.length ? scenario.calls : [[]]) {
      const { id: callId } = await requestScenario<{ id: string }>(worker, { action: "start" });
      const conversation: object[] = [];
      let closure = false;

      const script = turns.flatMap((text, turn) => [
        { text, turn, recovery: false },
        ...(scenario.confirmationRecoveries?.[turn]
          ? [{ text: scenario.confirmationRecoveries[turn], turn, recovery: true }]
          : []),
      ]);

      if (script.length > limits.turns) {
        throw new Error("Scenario exceeded its caller turn bound.");
      }

      for (const { text, turn, recovery } of script) {
        if (
          recovery &&
          !tools.some(
            (entry): boolean =>
              entry.callId === callId &&
              entry.turn === turn &&
              !!entry.result &&
              typeof entry.result === "object" &&
              "error" in entry.result &&
              ["confirmation_unclear", "evidence_required"].includes(
                (entry.result as { error: { code: string } }).error.code,
              ),
          )
        ) {
          continue;
        }

        if (closure) {
          throw new Error("The model ended the call before the scripted caller finished.");
        }

        await requestScenario(worker, { action: "speech", callId, speaker: "input", text });
        conversation.push({ role: "user", content: text });

        for (let continuation = 0; ; continuation++) {
          controller.signal.throwIfAborted();

          if (continuation > limits.continuations || ++count > limits.requests) {
            throw new Error("Scenario exceeded its model request or tool continuation bound.");
          }

          const response = await runtime.requestProvider(
            "https://api.openai.com/v1/responses",
            {
              ...configuration.delegation,
              store: false,
              input: conversation,
            },
            controller.signal,
          );

          if (!response.ok) {
            throw new Error(`Delegated provider returned ${response.status}.`);
          }

          const result = (await response.json()) as {
            id: string;
            status: string;
            output: {
              type: string;
              name?: string;
              arguments?: string;
              call_id?: string;
              content?: { type: string; text?: string }[];
            }[];
          };
          responses.push({ callId, turn, ...result });

          if (result.status !== "completed") {
            throw new Error("Delegated response did not complete within its output bound.");
          }

          conversation.push(...result.output);
          const speech = result.output
            .flatMap(
              (item): string[] =>
                item.content
                  ?.filter((part): boolean => part.type === "output_text")
                  .map((part): string => part.text ?? "") ?? [],
            )
            .join("\n");

          if (speech) {
            await requestScenario(worker, { action: "speech", callId, speaker: "output", text: speech });
          }

          const functions = result.output.filter((item): boolean => item.type === "function_call");

          if (!functions.length) {
            break;
          }

          if (functions.length !== 1 || closure) {
            throw new Error("The model requested overlapping tools or work after call closure.");
          }

          const invocation = functions[0];
          const argumentsData = JSON.parse(invocation.arguments ?? "{}") as Record<string, unknown>;
          const output = await requestScenario<unknown>(worker, {
            action: "tool",
            callId,
            name: invocation.name,
            arguments: argumentsData,
            invocationId: invocation.call_id,
          });
          closure =
            invocation.name === "end_call" &&
            !!output &&
            typeof output === "object" &&
            "ended" in output &&
            output.ended === true;

          tools.push({ callId, turn, name: invocation.name ?? "", arguments: argumentsData, result: output });
          conversation.push({
            type: "function_call_output",
            call_id: invocation.call_id,
            output: JSON.stringify(output),
          });
        }

        const state = await requestScenario<Snapshot>(worker, { action: "state" });
        checkpoints.push({ callId, turn, agreements: state.agreements });
      }

      if (!turns.length) {
        await requestScenario(worker, { action: "fixture", callId, fixture: scenario.id });
      } else if (!closure) {
        await requestScenario(worker, { action: "finish", callId, interrupted: scenario.interruption ?? false });
      }

      analyses.push({
        callId,
        ...(await requestScenario<Omit<EvaluationResult["analyses"][number], "callId">>(worker, {
          action: "analysis",
          callId,
        })),
      });
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : "Evaluation failed.";
  }

  try {
    const state = await requestScenario<Snapshot>(worker, { action: "state" });

    if (!configuration) {
      throw new Error(error ?? "Evaluation configuration unavailable.");
    }

    return {
      suiteVersion,
      sourceHash: runtime.sourceHash,
      scenarioId: scenario.id,
      configuration,
      responses,
      tools,
      checkpoints,
      analyses,
      state,
      usage: runtime.usage.slice(usageStart),
      ...(error ? { error } : {}),
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await worker.dispose();
  }
}
