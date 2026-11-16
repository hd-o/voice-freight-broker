import { createHash } from "node:crypto";
import {
  callContextSchema,
  invocationSchema,
  toolArguments,
  type CallContext,
} from "@voice-freight/contracts/business";
import { authorizeCall } from "./authorization";
import { BusinessError, requireCondition, type State, type ReceiptOutcome, type Receipt } from "./model";
import { resolveTarget } from "./evidence";
import { createReadback, describeLoad } from "./readbacks";
import { checkAvailability } from "./inventory";
import { cancelAgreement, confirmHandoff } from "./agreements";
import { transact } from "./repository";
import { calculateAvailableMicrodollars, chargeUsage, resolvePeriod } from "./spending";
import {
  approveConfirmation,
  checkConfirmationConfidence,
  calculateConfirmationBound,
  confirmationAnswersSchema,
  confirmationAttemptSchema,
  confirmationInputSchema,
  confirmationLeaseMs,
  confirmationModel,
  confirmationOutcomeSchema,
  confirmationPolicyVersion,
  confirmationPrices,
  confirmationPromptVersion,
  confirmationQuietMs,
  type ConfirmationAttempt,
  type ConfirmationInput,
  type ConfirmationOutcome,
  type ConfirmationProvider,
} from "./confirmation-policy";
import type { ToolResult } from "./business";
import { observeOperation } from "./telemetry";

type ConfirmationName = "confirm_handoff" | "cancel_agreement";

function hashContent(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function prepareConfirmation(
  state: State,
  context: CallContext,
  action: "handoff" | "cancel",
  targetId: string,
  now: string,
): ConfirmationInput {
  const call = authorizeCall(state, context);
  const target = resolveTarget(state, call.id, action, targetId);
  const quote = state.quotes.find((entry): boolean => entry.id === targetId);
  const agreement = state.agreements.find((entry): boolean => entry.id === targetId);
  const replacement = quote?.replacementId
    ? state.agreements.find((entry): boolean => entry.id === quote.replacementId && entry.status === "effective")
    : undefined;
  const load = agreement?.load ?? call.record.loads.find((entry): boolean => entry.id === target.loadId);
  const session = state.liveSessions.find((entry): boolean => entry.id === call.id);

  requireCondition(
    load?.pickupTimeZone && call.record.carrier && call.verification?.carrierId === target.carrierId,
    "evidence_required",
    "A verified carrier, selected load and known pickup time zone are required.",
  );
  requireCondition(
    !quote?.replacementId || replacement,
    "agreement_unavailable",
    "The replacement target is no longer effective.",
  );
  requireCondition(
    action === "cancel" || checkAvailability(state, target.loadId, quote?.replacementId),
    "load_unavailable",
    "Another call secured this load. Choose another load.",
  );
  requireCondition(
    session && !session.gap && Date.parse(now) - Date.parse(session.lastInputAt) >= confirmationQuietMs,
    "evidence_required",
    "Wait until the caller finishes speaking, then request confirmation.",
  );

  const boundary = quote?.evidenceAfterMs ?? agreement?.evidenceAfterMs ?? 0;
  const fragments = state.transcriptFragments
    .filter((entry): boolean => entry.callId === call.id && entry.endMs > boundary)
    .sort((a, b): number => a.startMs - b.startMs || a.endMs - b.endMs || a.sequence - b.sequence);
  // Progress speech from the broker can follow a completed caller response.
  // Keep it in the classified snapshot so corrections cannot be hidden.
  const lastCaller = fragments.findLastIndex((entry): boolean => entry.speaker === "carrier");

  requireCondition(
    lastCaller >= 0,
    "evidence_required",
    "Ask for fresh caller confirmation after the complete readback.",
  );

  let firstCaller = lastCaller;

  while (firstCaller > 0 && fragments[firstCaller - 1].speaker === "carrier") {
    firstCaller--;
  }

  let firstBroker = firstCaller - 1;

  requireCondition(
    firstBroker >= 0 && fragments[firstBroker].speaker === "broker",
    "evidence_required",
    "The caller must respond after a fresh broker readback.",
  );

  while (firstBroker > 0 && fragments[firstBroker - 1].speaker === "broker") {
    firstBroker--;
  }

  const broker = fragments.slice(firstBroker, firstCaller);
  const caller = fragments.slice(firstCaller, lastCaller + 1);
  const brokerEndMs = Math.max(...broker.map((entry): number => entry.endMs));

  requireCondition(
    broker.every((entry): boolean => entry.startMs >= boundary) &&
      caller.every((entry): boolean => entry.startMs >= brokerEndMs) &&
      broker[0].sequence < caller[0].sequence &&
      caller.every(
        (entry): boolean => entry.sequence > Math.max(...broker.map((fragment): number => fragment.sequence)),
      ),
    "evidence_required",
    "A fresh, non-overlapping readback and caller response are required.",
  );
  requireCondition(
    fragments.length - firstBroker <= 128,
    "evidence_required",
    "Please give a fresh concise readback and request a short complete response.",
  );

  const input = confirmationInputSchema.parse({
    callId: call.id,
    action: action === "cancel" ? "cancel" : quote?.replacementId ? "replace" : "handoff",
    targetId,
    contextVersion: target.contextVersion,
    terms: {
      ...target,
      carrierName: call.record.carrier.name,
      loadId: load.id,
      reference: load.reference,
      origin: load.origin,
      destination: load.destination,
      equipment: load.equipment,
      pickupAt: load.pickupAt,
      pickupTimeZone: load.pickupTimeZone,
      localPickup: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: load.pickupTimeZone,
      }).format(new Date(load.pickupAt)),
      spokenLabel: describeLoad(state, call.id, load).spokenLabel,
      replacementId: replacement?.id ?? null,
      replacementVersion: replacement?.version ?? null,
    },
    fragments: fragments
      .slice(firstBroker)
      .map(({ callId: _callId, ...fragment }): Omit<typeof fragment, never> => fragment),
    readbackIds: broker.map((entry): string => entry.id),
    callerIds: caller.map((entry): string => entry.id),
  });

  try {
    calculateConfirmationBound(input);
  } catch {
    throw new BusinessError(
      "evidence_required",
      "Please give a fresh concise readback and request a short complete response.",
    );
  }

  return input;
}

function recordConfirmation(
  state: State,
  input: ConfirmationInput,
  attempt: ConfirmationAttempt,
  now: string,
): { readbackId: string; callerId: string } {
  const target = resolveTarget(state, input.callId, input.action === "cancel" ? "cancel" : "handoff", input.targetId);
  const references = { readbackId: `${attempt.id}:readback`, callerId: `${attempt.id}:caller` };

  for (const speaker of ["broker", "carrier"] as const) {
    const ids = speaker === "broker" ? input.readbackIds : input.callerIds;
    const fragment = input.fragments.find((entry): boolean => entry.id === ids[0])!;

    state.evidence.push({
      id: speaker === "broker" ? references.readbackId : references.callerId,
      callId: input.callId,
      ...target,
      recordedAt: now,
      speaker,
      // Text remains in transcriptFragments; evidence records only server references.
      text: `Observed confirmation ${attempt.id}`,
      transcriptIds: ids,
      confirmationAttemptId: attempt.id,
      offsetSeconds: Math.floor(fragment.startMs / 1000),
      action: input.action === "cancel" ? "cancel" : "handoff",
      targetId: input.targetId,
      ...(speaker === "carrier" ? { readbackId: references.readbackId, confirmed: true } : { confirmed: false }),
    });
  }

  return references;
}

function recoverConfirmation(
  state: State,
  context: CallContext,
  input: ConfirmationInput,
  answers: ConfirmationOutcome["answers"],
): BusinessError {
  const failures =
    state.confirmationAttempts.filter(
      (entry): boolean =>
        entry.callId === context.callId &&
        entry.targetId === input.targetId &&
        entry.status === "rejected" &&
        !!entry.outcome?.answers &&
        (!checkConfirmationConfidence(entry.outcome.answers) ||
          !["decline", "request_change"].includes(entry.outcome.answers.intent.choice)),
    ).length + 1;
  const limit =
    failures >= 2
      ? " Two confirmation attempts failed. Offer another load or ending the call; do not keep asking for the same confirmation."
      : "";

  if (!answers || !checkConfirmationConfidence(answers)) {
    return new BusinessError(
      "confirmation_unclear",
      `The agreement change was not saved. Ask the caller to clarify their complete response.${limit}`,
    );
  }

  if (answers?.intent.choice === "decline") {
    return new BusinessError(
      "confirmation_declined",
      "The agreement change was not saved. Respect the caller's rejection and offer another load or ending the call.",
    );
  }

  if (answers?.intent.choice === "request_change") {
    return new BusinessError(
      "confirmation_change",
      "The agreement change was not saved. Clarify the requested change and return to search_loads, evaluate_offer, or begin_renegotiation as applicable. Obtain a new quote and readback before asking for acceptance of changed terms.",
    );
  }

  if (answers && answers.readback.choice !== "matches") {
    const load = state.calls
      .find((entry): boolean => entry.id === context.callId)!
      .record.loads.find((entry): boolean => entry.id === input.terms.loadId)!;
    const readback = createReadback(state, context.callId, load, input.terms.rateCents, input.action);

    return new BusinessError(
      "evidence_required",
      `The agreement change was not saved. Read this back: ${readback} Request fresh confirmation.${limit}`,
    );
  }

  return new BusinessError(
    "confirmation_unclear",
    `The agreement change was not saved. Ask the caller to clarify their complete response.${limit}`,
  );
}

function unwrapReceipt(outcome: ReceiptOutcome): ToolResult {
  if ("error" in outcome) {
    throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
  }

  return outcome.result;
}

export async function executeConfirmation(
  binding: D1Database,
  context: CallContext,
  name: ConfirmationName,
  invocation: { invocationId: string; arguments: unknown },
  provider: ConfirmationProvider,
  now = new Date().toISOString(),
): Promise<ToolResult> {
  callContextSchema.parse(context);
  invocationSchema.parse(invocation);
  const raw =
    invocation.arguments && typeof invocation.arguments === "object" && !Array.isArray(invocation.arguments)
      ? invocation.arguments
      : {};
  const argumentsData = toolArguments[name].parse({
    ...raw,
    evidence: { readbackId: "server-observed", callerId: "server-observed" },
  });
  const targetId = "quoteId" in argumentsData ? argumentsData.quoteId : argumentsData.agreementId;
  const action = name === "cancel_agreement" ? "cancel" : "handoff";
  const fingerprint = JSON.stringify({ name, arguments: argumentsData });
  const id = `${context.callId}:${invocation.invocationId}`;
  const started = Date.now();

  const claim = await transact(
    binding,
    (state): { receipt: Receipt } | { attempt: ConfirmationAttempt; input: ConfirmationInput } => {
      authorizeCall(state, context, false);
      const receipt = state.receipts.find((entry): boolean => entry.id === id);

      if (receipt) {
        requireCondition(
          receipt.fingerprint === fingerprint,
          "invocation_conflict",
          "Invocation identity was already used with different arguments.",
        );
        return { receipt };
      }

      const previous = state.confirmationAttempts.find((entry): boolean => entry.id === id);

      if (previous) {
        requireCondition(
          previous.fingerprint === fingerprint,
          "invocation_conflict",
          "Invocation identity was already used with different arguments.",
        );
        requireCondition(
          Date.parse(previous.leaseUntil) <= Date.parse(now),
          "confirmation_pending",
          "Confirmation is still being checked. Wait for its result.",
        );
        // Never reclaim a potentially paid request. A lost reply retains its reservation.
        previous.status = "failed";
        previous.finishedAt = now;
        const receipt: Receipt = {
          id,
          callId: context.callId,
          fingerprint,
          error: {
            code: "confirmation_unavailable",
            message:
              "The agreement change was not saved. Confirmation could not be checked. Please request a fresh exchange or try later.",
            status: 409,
          },
        };
        previous.receiptId = id;
        state.receipts.push(receipt);
        return { receipt };
      }

      try {
        const input = prepareConfirmation(state, context, action, targetId, now);
        const inputHash = hashContent(input);
        const duplicate = state.confirmationAttempts.find(
          (entry): boolean => entry.callId === context.callId && entry.inputHash === inputHash,
        );

        requireCondition(
          !duplicate,
          "confirmation_pending",
          "This exchange has already been checked or is being checked. Request a fresh readback and response.",
        );

        const tokens = calculateConfirmationBound(input);
        const bound = Math.ceil((tokens * confirmationPrices.inputMicrodollarsPerMillionTokens) / 1_000_000);

        requireCondition(
          calculateAvailableMicrodollars(state, now) >= bound,
          "confirmation_unavailable",
          "The agreement change was not saved. Confirmation is unavailable for now. Offer to try later.",
        );

        const attempt = confirmationAttemptSchema.parse({
          id,
          callId: context.callId,
          ownerId: context.userId,
          invocationId: invocation.invocationId,
          fingerprint,
          action: input.action,
          targetId,
          contextVersion: input.contextVersion,
          inputHash,
          evidence: input.fragments.map((entry): { id: string; hash: string } => ({
            id: entry.id,
            hash: hashContent(entry),
          })),
          readbackIds: input.readbackIds,
          callerIds: input.callerIds,
          model: confirmationModel,
          promptVersion: confirmationPromptVersion,
          policyVersion: confirmationPolicyVersion,
          startedAt: now,
          leaseUntil: new Date(Date.parse(now) + confirmationLeaseMs).toISOString(),
          status: "evaluating",
        });

        state.confirmationAttempts.push(attempt);
        state.reservations.push({
          id,
          kind: "confirmation",
          ownerId: context.userId,
          operationId: id,
          createdAt: now,
          reservedMicrodollars: bound,
          chargedMicrodollars: 0,
          settled: false,
          prices: confirmationPrices,
        });
        return { attempt, input };
      } catch (error) {
        if (!(error instanceof BusinessError) || error.status >= 500) {
          throw error;
        }
        const receipt: Receipt = {
          id,
          callId: context.callId,
          fingerprint,
          error: {
            code: error.code,
            message: error.message.startsWith("The agreement change was not saved.")
              ? error.message
              : `The agreement change was not saved. ${error.message}`,
            status: error.status,
          },
        };
        state.receipts.push(receipt);
        return { receipt };
      }
    },
  );

  if ("receipt" in claim) {
    return unwrapReceipt(claim.receipt);
  }

  let outcome: ConfirmationOutcome;

  try {
    outcome = confirmationOutcomeSchema.parse(await provider(claim.input, id));
  } catch {
    outcome = { status: "failed", reason: "provider_unavailable", usage: null, latencyMs: Date.now() - started };
  }

  const finishedAt = new Date(Date.parse(now) + Date.now() - started).toISOString();
  const result = await transact<ReceiptOutcome>(binding, (state): ReceiptOutcome => {
    const attempt = state.confirmationAttempts.find((entry): boolean => entry.id === id)!;
    const reservation = state.reservations.find((entry): boolean => entry.id === id)!;

    // Settlement also runs for late results; an expired claim cannot apply facts.
    if (!attempt.outcome) {
      attempt.outcome = outcome;
      attempt.finishedAt = finishedAt;

      if (outcome.status === "not_started") {
        reservation.settled = true;
      } else if (outcome.usage && outcome.usage.cacheWriteTokens === 0) {
        const cost = Math.ceil(
          (outcome.usage.inputTokens * reservation.prices.inputMicrodollarsPerMillionTokens) / 1_000_000,
        );
        chargeUsage(state, id, `${id}:decisions`, resolvePeriod(attempt.startedAt), cost);
        reservation.settled = true;
        attempt.chargedMicrodollars = cost;
      }
    }

    const receipt = state.receipts.find((entry): boolean => entry.id === id);

    if (receipt) {
      return receipt;
    }

    let result: ReceiptOutcome;
    const draft = structuredClone(state);

    try {
      requireCondition(
        attempt.status === "evaluating" && Date.parse(finishedAt) <= Date.parse(attempt.leaseUntil),
        "stale_confirmation",
        "The agreement change was not saved. Request a fresh readback and confirmation.",
      );
      const current = prepareConfirmation(draft, context, action, targetId, finishedAt);
      requireCondition(
        hashContent(current) === attempt.inputHash,
        "stale_confirmation",
        "The agreement change was not saved. The conversation changed. Request a fresh readback and confirmation.",
      );
      requireCondition(
        outcome.status === "evaluated" && outcome.answers && outcome.usage && reservation.settled,
        "confirmation_unavailable",
        "The agreement change was not saved. Confirmation could not be checked. Explain this and offer to try later.",
      );
      const answers = confirmationAnswersSchema.parse(outcome.answers);

      if (!approveConfirmation(answers)) {
        throw recoverConfirmation(draft, context, current, answers);
      }

      const references = recordConfirmation(draft, current, attempt, finishedAt);
      const change =
        action === "cancel"
          ? cancelAgreement(draft, context.callId, targetId, references)
          : confirmHandoff(draft, context.callId, targetId, references);
      result = { result: change };
      Object.assign(state, draft);
      state.confirmationAttempts.find((entry): boolean => entry.id === id)!.status = "applied";
    } catch (error) {
      if (!(error instanceof BusinessError)) {
        throw error;
      }

      result = { error: { code: error.code, message: error.message, status: error.status } };
      attempt.status =
        [
          "stale_confirmation",
          "stale_quote",
          "call_ended",
          "agreement_unavailable",
          "load_unavailable",
          "evidence_required",
        ].includes(error.code) &&
        outcome.status === "evaluated" &&
        outcome.answers &&
        approveConfirmation(outcome.answers)
          ? "stale"
          : outcome.status === "evaluated"
            ? "rejected"
            : "failed";
    }

    state.confirmationAttempts.find((entry): boolean => entry.id === id)!.receiptId = id;
    state.receipts.push({ id, callId: context.callId, fingerprint, ...result });
    return result;
  });

  await observeOperation(
    {
      function: "confirmation",
      callId: context.callId,
      attemptId: id,
      providerId: outcome.requestId,
      action: claim.input.action,
      readback: outcome.answers?.readback.choice,
      intent: outcome.answers?.intent.choice,
      readbackConfidence: outcome.answers?.readback.confidence,
      intentConfidence: outcome.answers?.intent.confidence,
      readbackProbability: outcome.answers?.readback.probabilities.find(
        (entry): boolean => entry.value === outcome.answers?.readback.choice,
      )?.probability,
      intentProbability: outcome.answers?.intent.probabilities.find(
        (entry): boolean => entry.value === outcome.answers?.intent.choice,
      )?.probability,
      latencyMs: outcome.latencyMs,
      chargedMicrodollars:
        outcome.status !== "not_started" && outcome.usage && outcome.usage.cacheWriteTokens === 0
          ? Math.ceil(outcome.usage.inputTokens / 10)
          : undefined,
      promptVersion: confirmationPromptVersion,
      policyVersion: confirmationPolicyVersion,
      model: confirmationModel,
    },
    async (): Promise<string> => ("error" in result ? "failure" : "success"),
  );
  return unwrapReceipt(result);
}
