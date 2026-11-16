// Adapt Promptfoo's custom-provider interface to the bounded local Decisions
// endpoint. Stable run IDs let Promptfoo retries reuse D1 results without paying
// for duplicate classifications. Provider credentials stay in the API Worker.
import type { ProviderResponse } from "promptfoo";
import { confirmationFixtures } from "../packages/backend/src/confirmation-fixtures.ts";

let session: Promise<string> | undefined;

export default async function evaluateFixture(prompt: string): Promise<ProviderResponse> {
  // Admit only committed fixture IDs and loopback API origins.
  const fixtureId = prompt.trim();
  if (!confirmationFixtures.some((entry): boolean => entry.id === fixtureId)) {
    throw new Error("Unknown confirmation fixture");
  }
  const origin = process.env.CONFIRMATION_EVALUATION_ORIGIN ?? "http://localhost:8787";
  if (!["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
    throw new Error("A local API origin is required");
  }
  const runId = process.env.CONFIRMATION_EVALUATION_RUN_ID;
  if (!runId) {
    throw new Error("CONFIRMATION_EVALUATION_RUN_ID is required for durable replay");
  }
  const headers = { Origin: origin, "Content-Type": "application/json" };

  // Authenticate once as the local administrator, without reading the API key.
  session ??= (async (): Promise<string> => {
    const response = await fetch(new URL("/api/session", origin), {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: "administrator" }),
    });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (!response.ok || !cookie) {
      throw new Error("Local administrator session unavailable");
    }
    return cookie;
  })();

  // The API owns reservation, evaluation, settlement, and replay. No direct paid
  // request is possible from this adapter, including when Promptfoo retries it.
  const response = await fetch(new URL("/api/local/confirmations/evaluations", origin), {
    method: "POST",
    headers: { ...headers, Cookie: await session },
    body: JSON.stringify({ runId, fixtureId }),
  });
  if (!response.ok) {
    throw new Error(`Evaluation failed with HTTP ${response.status}; run ${runId}`);
  }
  const result = await response.json();
  return {
    output: JSON.stringify(result),
    tokenUsage: {
      prompt: result.outcome.usage?.inputTokens ?? 0,
      completion: 0,
      total: result.outcome.usage?.inputTokens ?? 0,
    },
  };
}
