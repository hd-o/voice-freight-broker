import { z } from "zod";
import {
  calculateConfirmationBound,
  confirmationAnswersSchema,
  confirmationInputSchema,
  confirmationModel,
  confirmationUsageSchema,
  createConfirmationRequest,
  type ConfirmationInput,
  type ConfirmationOutcome,
} from "./confirmation-policy";

export type ConfirmationConfiguration = {
  OPENAI_API_KEY?: string;
  ENVIRONMENT?: string;
  VOICE_PROVIDER?: string;
  CONFIRMATION_STUB_SCENARIO?: string;
};

export async function classifyConfirmation(
  input: ConfirmationInput,
  attemptId: string,
  configuration: ConfirmationConfiguration,
): Promise<ConfirmationOutcome> {
  const started = Date.now();
  const parsed = confirmationInputSchema.safeParse(input);

  try {
    if (!parsed.success) {
      return { status: "not_started", reason: "invalid_output", usage: null, latencyMs: 0 };
    }

    calculateConfirmationBound(parsed.data);
  } catch {
    return { status: "not_started", reason: "invalid_output", usage: null, latencyMs: 0 };
  }

  if (configuration.ENVIRONMENT === "local" && configuration.VOICE_PROVIDER === "stub") {
    // Canned classifications only: stub mode never infers intent or calls OpenAI.
    const scenario = configuration.CONFIRMATION_STUB_SCENARIO;

    if (scenario === "failure" || (scenario === "recovery" && input.action !== "handoff")) {
      return { status: "not_started", reason: "provider_unavailable", usage: null, latencyMs: 0 };
    }

    const readback = scenario === "mismatch" ? "mismatch" : scenario === "incomplete" ? "incomplete" : "matches";
    const intent =
      scenario === "decline"
        ? "decline"
        : scenario === "request_change"
          ? "request_change"
          : scenario === "unclear"
            ? "unclear"
            : "accept";

    return {
      status: "evaluated",
      requestId: `stub-${attemptId}`,
      latencyMs: 0,
      usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0 },
      answers: confirmationAnswersSchema.parse({
        readback: {
          name: "readback_accuracy",
          type: "choice",
          choice: readback,
          confidence: 1,
          probabilities: ["matches", "mismatch", "incomplete"].map((value): object => ({
            value,
            probability: value === readback ? 1 : 0,
          })),
        },
        intent: {
          name: "caller_intent",
          type: "choice",
          choice: intent,
          confidence: 1,
          probabilities: ["accept", "decline", "request_change", "unclear"].map((value): object => ({
            value,
            probability: value === intent ? 1 : 0,
          })),
        },
      }),
    };
  }

  if (!configuration.OPENAI_API_KEY) {
    return { status: "not_started", reason: "missing_access", usage: null, latencyMs: 0 };
  }

  let requestId: string | undefined;

  try {
    const response = await fetch("https://api.openai.com/v1/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "X-Client-Request-Id": attemptId,
      },
      body: JSON.stringify(createConfirmationRequest(input)),
      signal: AbortSignal.timeout(12_000),
    });

    requestId = response.headers.get("x-request-id") ?? undefined;

    if (!response.ok) {
      const access = response.status === 401 || response.status === 403;

      return {
        status: access || response.status === 429 || response.status === 400 ? "not_started" : "failed",
        reason: access ? "missing_access" : "provider_unavailable",
        requestId,
        usage: null,
        latencyMs: Date.now() - started,
      };
    }

    const body: unknown = await response.json();
    const envelope = z
      .object({ model: z.literal(confirmationModel), answers: z.array(z.unknown()), usage: z.unknown().optional() })
      .safeParse(body);
    const rawUsage = z
      .object({
        input_tokens: z.number(),
        input_tokens_details: z.object({ cached_tokens: z.number(), cache_write_tokens: z.number() }),
      })
      .safeParse(body && typeof body === "object" && "usage" in body ? body.usage : undefined);
    const usage = rawUsage.success
      ? confirmationUsageSchema.safeParse({
          inputTokens: rawUsage.data.input_tokens,
          cachedInputTokens: rawUsage.data.input_tokens_details.cached_tokens,
          cacheWriteTokens: rawUsage.data.input_tokens_details.cache_write_tokens,
        })
      : null;
    const counters = usage?.success ? usage.data : null;
    const base = { requestId, usage: counters, latencyMs: Date.now() - started };

    if (!envelope.success || envelope.data.answers.length !== 2) {
      return { ...base, status: "failed", reason: "invalid_output" };
    }

    if (
      envelope.data.answers.some(
        (answer): boolean => z.object({ type: z.literal("refusal") }).safeParse(answer).success,
      )
    ) {
      return { ...base, status: "failed", reason: "refusal" };
    }

    const answers = confirmationAnswersSchema.safeParse({
      readback: envelope.data.answers.find(
        (answer): boolean => z.object({ name: z.literal("readback_accuracy") }).safeParse(answer).success,
      ),
      intent: envelope.data.answers.find(
        (answer): boolean => z.object({ name: z.literal("caller_intent") }).safeParse(answer).success,
      ),
    });

    if (!answers.success) {
      return { ...base, status: "failed", reason: "invalid_output" };
    }

    return counters && counters.cacheWriteTokens === 0
      ? { ...base, status: "evaluated", answers: answers.data }
      : { ...base, status: "failed", reason: "usage_uncertain" };
  } catch (error) {
    return {
      status: "failed",
      reason:
        error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)
          ? "timeout"
          : "provider_unavailable",
      requestId,
      usage: null,
      latencyMs: Date.now() - started,
    };
  }
}
