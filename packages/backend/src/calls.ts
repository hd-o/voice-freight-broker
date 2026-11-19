import type { Call } from "@voice-freight/contracts/calls";
import { finalizationSchema, type CallContext } from "@voice-freight/contracts/business";
import { authorizeCall, resolveIdentity } from "./authorization";
import { requireCondition } from "./model";
import { transact } from "./repository";
import type { State } from "./model";

export async function createCall(
  binding: D1Database,
  userId: string,
  now = new Date().toISOString(),
): Promise<{ id: string }> {
  return transact(binding, (state): { id: string } => initializeCall(state, userId, now));
}

export function initializeCall(
  state: State,
  userId: string,
  now: string,
  id: string = crypto.randomUUID(),
): { id: string } {
  resolveIdentity(state, userId);

  requireCondition(state.inventory.length > 0, "inventory_unavailable", "Seed local inventory before creating calls.");

  state.calls.push({
    id,
    ownerId: userId,
    inventoryIds: state.inventory.map((entry): string => entry.id),
    verification: null,
    selectedLoadId: null,
    quoteId: null,
    finalSnapshot: null,
    record: {
      id,
      source: "Live",
      startedAt: now,
      endedAt: null,
      carrier: null,
      eligibility: "Unknown",
      matched: false,
      unresolvedError: false,
      connection: "Ended normally",
      outcomeReason: "Caller ended",
      loads: [],
      agreements: [],
      analysis: { status: "pending", sentiment: "Unknown", summary: null },
      transcript: { complete: false, entries: [] },
    },
  });

  return { id };
}

export async function finalizeCall(
  binding: D1Database,
  context: CallContext,
  input: {
    connection: "Ended normally" | "Interrupted" | "Connection failed";
    transcriptComplete: boolean;
  },
  now = new Date().toISOString(),
): Promise<Call> {
  const command = finalizationSchema.parse(input);

  return transact(binding, (state): Call => completeCall(state, context, command, now));
}

export function completeCall(
  state: State,
  context: CallContext,
  command: {
    connection: "Ended normally" | "Interrupted" | "Connection failed";
    transcriptComplete: boolean;
  },
  now: string,
): Call {
  const call = authorizeCall(state, context, false);

  if (call.finalSnapshot) {
    return call.finalSnapshot;
  }

  requireCondition(
    Date.parse(now) >= Date.parse(call.record.startedAt),
    "invalid_clock",
    "Call end precedes start.",
    400,
  );

  call.record.endedAt = now;
  call.record.connection = command.connection;
  call.record.unresolvedError = command.connection !== "Ended normally";
  call.record.transcript.complete = command.transcriptComplete;

  call.record.outcomeReason = call.record.unresolvedError
    ? "System error"
    : call.record.agreements.length &&
        !call.record.agreements.some((agreement): boolean => agreement.status === "effective")
      ? "All agreements cancelled"
      : call.verification?.status === "ineligible"
        ? "Carrier ineligible"
        : call.record.matched
          ? "No agreement"
          : call.verification?.status === "eligible"
            ? "No matching load"
            : "Caller ended";

  for (const quote of state.quotes.filter((quote): boolean => quote.callId === call.id)) {
    quote.valid = false;
  }

  call.quoteId = null;
  call.finalSnapshot = structuredClone(call.record);

  state.analysis.push({
    id: call.id,
    callId: call.id,
    version: 1,
    status: "pending",
    publication: "pending",
    attempts: 0,
    createdAt: now,
  });

  return call.finalSnapshot;
}
