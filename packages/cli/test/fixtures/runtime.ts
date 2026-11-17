import { randomUUID } from "node:crypto";
import { EvaluationRuntime as Runtime, migrateDatabase } from "../../../../evals/runtime.ts";

export { bundleWorkers } from "../../../../evals/runtime.ts";
const directory = process.env.FREIGHT_CLI_EVALUATION_DIRECTORY;

if (!directory) {
  throw new Error("The CLI evaluation test requires an isolated directory.");
}

export const repositoryPath = directory;

export function readCredential(): Promise<string> {
  return Promise.resolve("test-only-credential");
}

export class EvaluationRuntime extends Runtime {
  constructor(bundles: ConstructorParameters<typeof Runtime>[0], credential: string) {
    super(bundles, credential, {
      storagePath: repositoryPath,
      transport: async (url): Promise<Response> => {
        if (typeof url !== "string" || !url.endsWith("/decisions")) {
          throw new Error("Unexpected provider request in the CLI confirmation test.");
        }

        // Always approve so the real scorer passes acceptance and fails a wrong rate.
        return Response.json(
          {
            model: "gpt-6-luna",
            answers: [
              {
                name: "readback_accuracy",
                type: "choice",
                choice: "matches",
                confidence: 1,
                probabilities: [
                  { value: "matches", probability: 1 },
                  { value: "mismatch", probability: 0 },
                  { value: "incomplete", probability: 0 },
                ],
              },
              {
                name: "caller_intent",
                type: "choice",
                choice: "accept",
                confidence: 1,
                probabilities: [
                  { value: "accept", probability: 1 },
                  { value: "decline", probability: 0 },
                  { value: "request_change", probability: 0 },
                  { value: "unclear", probability: 0 },
                ],
              },
            ],
            usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } },
          },
          { headers: { "x-request-id": randomUUID() } },
        );
      },
    });
  }

  async verifyLedger(): Promise<void> {
    await migrateDatabase(this.ledger);
    await super.verifyLedger();
  }
}
