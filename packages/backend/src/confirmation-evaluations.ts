import { createHash } from "node:crypto";
import { z } from "zod";
import { authorizeAdministrator } from "./authorization";
import { transact } from "./repository";
import { requireCondition } from "./model";
import { calculateAvailableMicrodollars, chargeUsage, resolvePeriod } from "./spending";
import { confirmationFixtures, createConfirmationFixture } from "./confirmation-fixtures";
import {
  approveConfirmation,
  calculateConfirmationBound,
  confirmationAttemptSchema,
  confirmationOutcomeSchema,
  confirmationModel,
  confirmationPolicyVersion,
  confirmationPrices,
  confirmationPromptVersion,
  type ConfirmationOutcome,
  type ConfirmationProvider,
} from "./confirmation-policy";

export const confirmationEvaluationSchema = z.strictObject({
  runId: z.string().uuid(),
  fixtureId: z.enum(confirmationFixtures.map((entry): string => entry.id)),
});

export async function evaluateConfirmation(
  binding: D1Database,
  userId: string,
  request: z.infer<typeof confirmationEvaluationSchema>,
  provider: ConfirmationProvider,
): Promise<{
  fixtureId: string;
  split: "tuning" | "heldout";
  expectedAccuracy: string;
  expectedIntent: string;
  expectedApproval: boolean;
  approval: boolean;
  outcome: ConfirmationOutcome;
  inference: { inputHash: string; fingerprint: string; model: string; promptVersion: string; policyVersion: string };
}> {
  const { runId, fixtureId } = confirmationEvaluationSchema.parse(request);
  const input = createConfirmationFixture(fixtureId);
  const fixture = confirmationFixtures.find((entry): boolean => entry.id === fixtureId)!;
  const id = `eval:${runId}:${fixtureId}`;
  const now = new Date().toISOString();
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ input, accuracy: fixture.accuracy, intent: fixture.intent }))
    .digest("hex");
  const previous = await transact(binding, (state): { outcome: ConfirmationOutcome | null; policyVersion: string } => {
    authorizeAdministrator(state, userId);
    const attempt = state.confirmationAttempts.find((entry): boolean => entry.id === id);

    if (attempt) {
      requireCondition(
        attempt.inputHash === hash &&
          attempt.fingerprint === fingerprint &&
          attempt.model === confirmationModel &&
          attempt.promptVersion === confirmationPromptVersion,
        "invocation_conflict",
        "This evaluation identity belongs to different input, labels, model, or prompt. Use a new run ID.",
      );
    }
    if (attempt?.outcome) {
      return { outcome: attempt.outcome, policyVersion: attempt.policyVersion };
    }
    requireCondition(!attempt, "confirmation_pending", "Evaluation has an unresolved provider attempt.");
    const bound = Math.ceil(
      (calculateConfirmationBound(input) * confirmationPrices.inputMicrodollarsPerMillionTokens) / 1_000_000,
    );
    requireCondition(
      calculateAvailableMicrodollars(state, now) >= bound,
      "budget_exhausted",
      "Evaluation allowance is exhausted.",
    );
    state.confirmationAttempts.push(
      confirmationAttemptSchema.parse({
        id,
        callId: "evaluation",
        ownerId: userId,
        invocationId: id,
        fingerprint,
        action: input.action,
        targetId: input.targetId,
        contextVersion: input.contextVersion,
        inputHash: hash,
        evidence: [{ id: fixtureId, hash }],
        readbackIds: input.readbackIds,
        callerIds: input.callerIds,
        model: confirmationModel,
        promptVersion: confirmationPromptVersion,
        policyVersion: confirmationPolicyVersion,
        startedAt: now,
        leaseUntil: new Date(Date.parse(now) + 30_000).toISOString(),
        status: "evaluating",
      }),
    );
    state.reservations.push({
      id,
      ownerId: userId,
      operationId: id,
      kind: "confirmation",
      createdAt: now,
      reservedMicrodollars: bound,
      chargedMicrodollars: 0,
      settled: false,
      prices: confirmationPrices,
    });
    return { outcome: null, policyVersion: confirmationPolicyVersion };
  });

  let outcome = previous.outcome;

  if (!outcome) {
    try {
      outcome = confirmationOutcomeSchema.parse(await provider(input, id));
    } catch {
      outcome = { status: "failed", reason: "provider_unavailable", usage: null, latencyMs: 0 };
    }

    const result = outcome;
    await transact(binding, (state): void => {
      const attempt = state.confirmationAttempts.find((entry): boolean => entry.id === id)!;
      if (attempt.outcome) {
        return;
      }
      const reservation = state.reservations.find((entry): boolean => entry.id === id)!;
      attempt.outcome = result;
      attempt.status = result.status === "evaluated" ? "evaluated" : "failed";
      attempt.finishedAt = new Date().toISOString();
      if (result.status === "not_started") {
        reservation.settled = true;
      } else if (result.usage && result.usage.cacheWriteTokens === 0) {
        const cost = Math.ceil(
          (result.usage.inputTokens * confirmationPrices.inputMicrodollarsPerMillionTokens) / 1_000_000,
        );
        chargeUsage(state, id, `${id}:decisions`, resolvePeriod(now), cost);
        reservation.settled = true;
        attempt.chargedMicrodollars = cost;
      }
    });
  }

  return {
    fixtureId,
    inference: {
      inputHash: hash,
      fingerprint,
      model: confirmationModel,
      promptVersion: confirmationPromptVersion,
      policyVersion: previous.policyVersion,
    },
    split: fixture.split,
    expectedAccuracy: fixture.accuracy,
    expectedIntent: fixture.intent,
    expectedApproval: fixture.accuracy === "matches" && fixture.intent === "accept",
    approval: outcome.status === "evaluated" && !!outcome.answers && approveConfirmation(outcome.answers),
    outcome,
  };
}
