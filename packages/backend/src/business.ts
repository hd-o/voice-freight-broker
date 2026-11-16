import {
  callContextSchema,
  invocationSchema,
  toolArguments,
  toolNameSchema,
  type CallContext,
  type ToolName,
} from "@voice-freight/contracts/business";
import { authorizeCall } from "./authorization";
import { BusinessError, requireCondition, type ReceiptOutcome } from "./model";
import { verifyCarrier } from "./carriers";
import { searchLoads } from "./inventory";
import { issueQuote, evaluateOffer } from "./negotiations";
import { beginRenegotiation, confirmHandoff, cancelAgreement } from "./agreements";
import { transact } from "./repository";
import { captureConfirmation } from "./confirmation";
import { resolveTarget } from "./evidence";
import { observeOperation, sanitizeTelemetry } from "./telemetry";
import { createReadback } from "./readbacks";

export type ToolResult =
  | ReturnType<typeof verifyCarrier>
  | ReturnType<typeof searchLoads>
  | ReturnType<typeof issueQuote>
  | ReturnType<typeof evaluateOffer>
  | ReturnType<typeof confirmHandoff>
  | ReturnType<typeof cancelAgreement>;

export async function executeTool(
  binding: D1Database,
  context: CallContext,
  name: ToolName,
  invocation: { invocationId: string; arguments: unknown },
  now = new Date().toISOString(),
  observed = false,
): Promise<ToolResult> {
  return observeOperation(
    {
      ...sanitizeTelemetry(invocation.arguments),
      callId: context.callId,
      invocationId: invocation.invocationId,
      function: name,
    },
    () => applyTool(binding, context, name, invocation, now, observed),
  );
}

async function applyTool(
  binding: D1Database,
  context: CallContext,
  name: ToolName,
  invocation: { invocationId: string; arguments: unknown },
  now = new Date().toISOString(),
  observed = false,
): Promise<ToolResult> {
  callContextSchema.parse(context);
  toolNameSchema.parse(name);
  invocationSchema.parse(invocation);

  const argumentsData = toolArguments[name].parse(
    observed && (name === "confirm_handoff" || name === "cancel_agreement")
      ? {
          ...parseObservedArguments(invocation.arguments),
          evidence: {
            readbackId: "server-observed",
            callerId: "server-observed",
          },
        }
      : invocation.arguments,
  );

  const fingerprint = JSON.stringify({ name, arguments: argumentsData });

  const outcome = await transact<ReceiptOutcome>(binding, (state): ReceiptOutcome => {
    authorizeCall(state, context, false);
    const id = `${context.callId}:${invocation.invocationId}`;
    const receipt = state.receipts.find((receipt): boolean => receipt.id === id);

    if (receipt) {
      requireCondition(
        receipt.fingerprint === fingerprint,
        "invocation_conflict",
        "Invocation identity was already used with different arguments.",
      );

      return receipt;
    }

    const draft = structuredClone(state);
    let outcome: ReceiptOutcome;

    try {
      authorizeCall(draft, context);
      let result: ToolResult;

      switch (name) {
        case "verify_carrier":
          result = verifyCarrier(
            draft,
            context.callId,
            toolArguments.verify_carrier.parse(argumentsData).mcNumber,
            now,
          );

          break;
        case "search_loads":
          result = searchLoads(draft, context.callId, toolArguments.search_loads.parse(argumentsData));
          break;
        case "select_load":
          result = issueQuote(draft, context.callId, toolArguments.select_load.parse(argumentsData).loadId);
          break;
        case "evaluate_offer": {
          const input = toolArguments.evaluate_offer.parse(argumentsData);

          result = evaluateOffer(draft, context.callId, input.quoteId, input.amountCents);
          break;
        }
        case "begin_renegotiation":
          result = beginRenegotiation(
            draft,
            context.callId,
            toolArguments.begin_renegotiation.parse(argumentsData).agreementId,
          );

          break;
        case "confirm_handoff": {
          const input = toolArguments.confirm_handoff.parse(argumentsData);

          result = confirmHandoff(
            draft,
            context.callId,
            input.quoteId,
            observed ? captureConfirmation(draft, context, "handoff", input.quoteId) : input.evidence,
          );

          break;
        }
        case "cancel_agreement": {
          const input = toolArguments.cancel_agreement.parse(argumentsData);

          result = cancelAgreement(
            draft,
            context.callId,
            input.agreementId,
            observed ? captureConfirmation(draft, context, "cancel", input.agreementId) : input.evidence,
          );

          break;
        }
      }

      outcome = { result };
      Object.assign(state, draft);
    } catch (error) {
      if (!(error instanceof BusinessError) || error.status >= 500) {
        throw error;
      }

      let message = error.message;

      if (
        observed &&
        error.code === "evidence_required" &&
        (name === "confirm_handoff" || name === "cancel_agreement")
      ) {
        const targetId =
          name === "confirm_handoff"
            ? toolArguments.confirm_handoff.parse(argumentsData).quoteId
            : toolArguments.cancel_agreement.parse(argumentsData).agreementId;

        const action = name === "cancel_agreement" ? "cancel" : "handoff";
        const target = resolveTarget(state, context.callId, action, targetId);
        const call = state.calls.find((entry): boolean => entry.id === context.callId)!;
        const load = call.record.loads.find((entry): boolean => entry.id === target.loadId)!;
        const quote = state.quotes.find((entry): boolean => entry.id === targetId);

        const failures =
          state.receipts.filter(
            (entry): boolean =>
              entry.callId === context.callId &&
              entry.fingerprint === fingerprint &&
              "error" in entry &&
              entry.error.code === "evidence_required",
          ).length + 1;

        const readback = createReadback(
          state,
          call.id,
          load,
          target.rateCents,
          action === "cancel" ? "cancel" : quote?.replacementId ? "replace" : "handoff",
        );

        message = `The agreement change was not saved. ${error.message} Read this back: ${readback}${failures >= 2 ? " Two confirmation attempts failed. Explain the failure and offer another load or ending the call; do not keep asking for the same confirmation." : ""}`;
      }

      outcome = {
        error: {
          code: error.code,
          message,
          status: error.status,
        },
      };
    }

    state.receipts.push({
      id,
      callId: context.callId,
      fingerprint,
      ...outcome,
    });

    return outcome;
  });

  if ("error" in outcome) {
    throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
  }

  return outcome.result;
}

function parseObservedArguments(input: unknown): object {
  return input && typeof input === "object" && !Array.isArray(input) ? input : {};
}
