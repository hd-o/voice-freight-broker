import { evidenceSchema, type CallContext, type EvidenceInput } from "@voice-freight/contracts/business";
import type { State } from "./model";
import { requireCondition } from "./model";
import { authorizeCall } from "./authorization";
import { requireQuote } from "./negotiations";
import { transact } from "./repository";

export function resolveTarget(
  state: State,
  callId: string,
  action: "handoff" | "cancel",
  targetId: string,
): {
  carrierId: string;
  loadId: string;
  rateCents: number;
  contextVersion: string;
} {
  if (action === "handoff") {
    const { quote } = requireQuote(state, callId, targetId);

    return {
      carrierId: quote.carrierId,
      loadId: quote.loadId,
      rateCents: quote.rateCents,
      contextVersion: quote.id,
    };
  }

  const agreement = state.agreements.find(
    (agreement): boolean =>
      agreement.id === targetId && agreement.callId === callId && agreement.status === "effective",
  );

  requireCondition(agreement, "agreement_unavailable", "Agreement is not effective in this call.");

  return {
    carrierId: agreement.carrierId,
    loadId: agreement.load.id,
    rateCents: agreement.rateCents,
    contextVersion: `${agreement.id}:${agreement.version}`,
  };
}

export async function recordEvidence(
  binding: D1Database,
  context: CallContext,
  input: EvidenceInput,
  now = new Date().toISOString(),
): Promise<{
  id: string;
}> {
  const event = evidenceSchema.parse(input);

  return transact(binding, (state): { id: string } => {
    const call = authorizeCall(state, context);
    const target = resolveTarget(state, call.id, event.action, event.targetId);
    const existing = state.evidence.find((entry): boolean => entry.id === event.id);

    if (existing) {
      requireCondition(
        existing.callId === call.id &&
          JSON.stringify({
            ...event,
            ...target,
            callId: call.id,
            recordedAt: existing.recordedAt,
          }) === JSON.stringify(existing),
        "evidence_conflict",
        "Event identity was already used.",
      );

      return { id: event.id };
    }

    if (event.speaker === "carrier") {
      const readback = state.evidence.find(
        (entry): boolean =>
          entry.id === event.readbackId &&
          entry.callId === call.id &&
          entry.speaker === "broker" &&
          entry.contextVersion === target.contextVersion &&
          entry.action === event.action,
      );

      requireCondition(
        readback && event.offsetSeconds >= readback.offsetSeconds,
        "evidence_required",
        "Caller confirmation must follow the matching read-back.",
      );
    }

    state.evidence.push({
      ...event,
      ...target,
      callId: call.id,
      recordedAt: now,
    });

    if (!state.liveSessions.some((entry): boolean => entry.id === call.id)) {
      call.record.transcript.entries.push({
        id: event.id,
        speaker: event.speaker,
        offsetSeconds: event.offsetSeconds,
        text: event.text,
      });
    }

    return { id: event.id };
  });
}

export function requireEvidence(
  state: State,
  callId: string,
  action: "handoff" | "cancel",
  targetId: string,
  references: { readbackId: string; callerId: string },
): void {
  const target = resolveTarget(state, callId, action, targetId);

  const readback = state.evidence.find(
    (entry): boolean => entry.id === references.readbackId && entry.callId === callId,
  );

  const caller = state.evidence.find((entry): boolean => entry.id === references.callerId && entry.callId === callId);

  requireCondition(
    readback?.speaker === "broker" &&
      caller?.speaker === "carrier" &&
      readback.action === action &&
      caller.action === action &&
      readback.targetId === targetId &&
      caller.targetId === targetId &&
      readback.contextVersion === target.contextVersion &&
      caller.contextVersion === target.contextVersion &&
      caller.readbackId === readback.id &&
      caller.confirmed &&
      caller.offsetSeconds >= readback.offsetSeconds,
    "evidence_required",
    "Record a matching read-back and unambiguous caller confirmation.",
  );
}
