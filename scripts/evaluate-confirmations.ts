// Evaluate the fixed Decisions corpus through the local API so every paid
// request reserves and settles the same D1 allowance as live calls.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import evaluateFixture from "./confirmation-provider.ts";
import { confirmationFixtures } from "../packages/backend/src/confirmation-fixtures.ts";
import {
  confirmationPolicyVersion,
  confirmationPromptVersion,
  confirmationThresholds,
} from "../packages/backend/src/confirmation-policy.ts";

// Restrict this runner to loopback and require an explicit corpus split.
const origin = process.env.CONFIRMATION_EVALUATION_ORIGIN ?? "http://localhost:8787";
const url = new URL(origin);
if (!["localhost", "127.0.0.1"].includes(url.hostname)) {
  throw new Error("A local API origin is required");
}
const split = process.argv[2];
if (split !== "tuning" && split !== "heldout") {
  throw new Error("Usage: node scripts/evaluate-confirmations.ts tuning|heldout [run-id]");
}
const runId = process.argv[3] ?? randomUUID();
process.env.CONFIRMATION_EVALUATION_RUN_ID = runId;

// Run sequentially, capped by the committed corpus, with durable replay IDs.
const results = [];
for (const fixture of confirmationFixtures.filter((entry): boolean => entry.split === split)) {
  const response = await evaluateFixture(fixture.id);
  if (typeof response.output !== "string") {
    throw new Error("Expected evaluation output");
  }
  const result = JSON.parse(response.output);
  results.push(result);
  console.log(
    JSON.stringify({
      fixtureId: fixture.id,
      status: result.outcome.status,
      reason: result.outcome.reason,
      latencyMs: result.outcome.latencyMs,
    }),
  );
}

// Preserve typed answers, usage and latency, while omitting transcript contents.
const report = {
  runId,
  split,
  promptVersion: confirmationPromptVersion,
  policyVersion: confirmationPolicyVersion,
  thresholds: confirmationThresholds,
  cases: results.length,
  categoryAccuracy:
    results.filter(
      (entry): boolean =>
        entry.outcome.answers?.readback.choice === entry.expectedAccuracy &&
        entry.outcome.answers?.intent.choice === entry.expectedIntent,
    ).length / results.length,
  falseApprovals: results.filter((entry): boolean => !entry.expectedApproval && entry.approval).length,
  falseRejections: results.filter((entry): boolean => entry.expectedApproval && !entry.approval).length,
  failures: results.filter((entry): boolean => entry.outcome.status !== "evaluated").length,
  results,
};
await writeFile(`.local/confirmation-${split}-evaluation.json`, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, results: undefined }));
if (
  report.falseApprovals ||
  report.failures ||
  results.some(
    (entry): boolean =>
      ["regression", "regression-second", "memphis-acknowledgment", "memphis-checking"].includes(entry.fixtureId) &&
      !entry.approval,
  )
) {
  process.exitCode = 1;
}
