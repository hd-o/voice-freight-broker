import { tracing } from "cloudflare:workers";

const numericFields = new Set([
  "attempt",
  "durationMs",
  "amountCents",
  "rateCents",
  "version",
  "usedRounds",
  "remainingRounds",
  "count",
]);
const identityFields = new Set([
  "callId",
  "invocationId",
  "jobId",
  "loadId",
  "quoteId",
  "agreementId",
  "traceId",
  "spanId",
]);
const enumFields = new Set(["function", "status", "code", "decision", "action"]);
const values = new Set([
  "verify_carrier",
  "search_loads",
  "select_load",
  "evaluate_offer",
  "begin_renegotiation",
  "confirm_handoff",
  "cancel_agreement",
  "analysis",
  "call",
  "recovery",
  "success",
  "failure",
  "pending",
  "complete",
  "failed",
  "ack",
  "retry",
  "dead-letter",
  "connected",
  "ending",
  "ended",
  "connecting",
  "effective",
  "cancelled",
  "superseded",
  "eligible",
  "ineligible",
  "not_found",
  "unavailable",
  "invalid_input",
  "confirmation_required",
  "call_ended",
  "provider_unavailable",
  "invalid_output",
  "usage_uncertain",
  "retries_exhausted",
  "budget_exhausted",
  "busy",
  "forbidden",
  "internal_error",
  "repeated_price",
  "bargaining_exhausted",
  "price_allowed",
  "broker_counter",
  "evidence_required",
  "carrier_bound",
  "load_unavailable",
  "stale_quote",
  "accounting_unavailable",
]);

export function sanitizeTelemetry(input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== "object") {
    return {};
  }
  const result: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(input).slice(0, 64)) {
    if (numericFields.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      result[key] = value;
    } else if (
      identityFields.has(key) &&
      typeof value === "string" &&
      /^[a-zA-Z0-9:_-]{1,160}$/.test(value) &&
      !/sk[-_]|bearer|token|secret/i.test(value)
    ) {
      result[key] = value;
    } else if (enumFields.has(key) && typeof value === "string" && values.has(value)) {
      result[key] = value;
    }
  }

  result.truncated = Object.keys(input).length > 64;
  return result;
}

export async function observeOperation<T>(fields: Record<string, unknown>, command: () => Promise<T>): Promise<T> {
  const outcome = await tracing.enterSpan(
    "freight.operation",
    async (span): Promise<{ result: T } | { error: unknown }> => {
      const started = Date.now();
      try {
        span.setAttributes(sanitizeTelemetry(fields));
      } catch {
        /* Diagnostics cannot block business work. */
      }

      try {
        const result = await command();
        const outcome =
          typeof result === "string" && ["retry", "dead-letter"].includes(result)
            ? result
            : result && typeof result === "object" && "error" in result
              ? "failure"
              : "success";
        // Emit only a projection. Never stringify original arguments or results.
        const resultFields = result && typeof result === "object" ? sanitizeTelemetry(result) : {};
        const attributes = sanitizeTelemetry({
          ...fields,
          ...resultFields,
          status: outcome,
          durationMs: Date.now() - started,
          ...span.spanContext(),
        });
        try {
          span.setAttributes(attributes);
          console.log(attributes);
        } catch {
          /* Diagnostics are best effort. */
        }
        return { result };
      } catch (error) {
        const attributes = sanitizeTelemetry({
          ...fields,
          status: "failure",
          code: error && typeof error === "object" && "code" in error ? error.code : "internal_error",
          durationMs: Date.now() - started,
          ...span.spanContext(),
        });
        try {
          span.setAttributes(attributes);
          console.log(attributes);
        } catch {
          /* Diagnostics are best effort. */
        }
        // Return the exception across the span boundary without recording its
        // message. Adapters still receive the original domain error.
        return { error };
      }
    },
  );

  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}
