import type { State, Agreement } from "./model";
import { requireCondition } from "./model";
import { checkAvailability } from "./inventory";
import { issueQuote, requireQuote } from "./negotiations";
import { requireEvidence } from "./evidence";
import { createReadback } from "./readbacks";

export function beginRenegotiation(state: State, callId: string, agreementId: string): ReturnType<typeof issueQuote> {
  const agreement = state.agreements.find(
    (agreement): boolean =>
      agreement.id === agreementId && agreement.callId === callId && agreement.status === "effective",
  );

  requireCondition(agreement, "agreement_unavailable", "Only this active call's effective agreements may be replaced.");

  return issueQuote(state, callId, agreement.load.id, agreement.id);
}

export function confirmHandoff(
  state: State,
  callId: string,
  quoteId: string,
  evidence: { readbackId: string; callerId: string },
): {
  agreementId: string;
  cancellationReadback: string;
  loadId: string;
  rateCents: number;
  version: number;
  status: string;
  handoff: string;
} {
  const { call, quote } = requireQuote(state, callId, quoteId);
  requireEvidence(state, callId, "handoff", quoteId, evidence);

  requireCondition(
    checkAvailability(state, quote.loadId, quote.replacementId),
    "load_unavailable",
    "Another call secured this load. Choose another load.",
  );

  const previous = quote.replacementId
    ? state.agreements.find(
        (agreement): boolean =>
          agreement.id === quote.replacementId && agreement.callId === callId && agreement.status === "effective",
      )
    : null;

  requireCondition(
    !quote.replacementId || previous,
    "agreement_unavailable",
    "The replacement target is no longer effective.",
  );

  const load = call.record.loads.find((load): boolean => load.id === quote.loadId)!;

  const agreement: Agreement = {
    evidenceAfterMs: Math.max(
      0,
      ...state.transcriptFragments
        .filter((entry): boolean => entry.callId === callId)
        .map((entry): number => entry.endMs),
    ),
    id: crypto.randomUUID(),
    callId,
    ownerId: call.ownerId,
    carrierId: quote.carrierId,
    verification: structuredClone(call.verification!),
    load: structuredClone(load),
    rateCents: quote.rateCents,
    version: (previous?.version ?? 0) + 1,
    status: "effective",
    evidence,
  };

  if (previous) {
    previous.status = "superseded";
  }

  state.agreements.push(agreement);
  quote.valid = false;
  call.quoteId = null;
  synchronizeAgreements(state, callId);

  return {
    agreementId: agreement.id,
    cancellationReadback: createReadback(state, callId, load, agreement.rateCents, "cancel"),
    loadId: load.id,
    rateCents: agreement.rateCents,
    version: agreement.version,
    status: "effective",
    handoff: "simulated",
  };
}

export function cancelAgreement(
  state: State,
  callId: string,
  agreementId: string,
  evidence: { readbackId: string; callerId: string },
): {
  agreementId: string;
  status: string;
  released: boolean;
} {
  requireEvidence(state, callId, "cancel", agreementId, evidence);

  const agreement = state.agreements.find(
    (agreement): boolean =>
      agreement.id === agreementId && agreement.callId === callId && agreement.status === "effective",
  )!;

  agreement.status = "cancelled";
  agreement.cancellationEvidence = evidence;
  const call = state.calls.find((call): boolean => call.id === callId)!;

  for (const quote of state.quotes.filter((quote): boolean => quote.replacementId === agreementId)) {
    quote.valid = false;

    if (call.quoteId === quote.id) {
      call.quoteId = null;
    }
  }

  synchronizeAgreements(state, callId);

  return { agreementId, status: "cancelled", released: true };
}

export function synchronizeAgreements(state: State, callId: string): void {
  const call = state.calls.find((call): boolean => call.id === callId)!;

  call.record.agreements = state.agreements
    .filter((agreement): boolean => agreement.callId === callId)
    .map((agreement): State["calls"][number]["record"]["agreements"][number] => ({
      id: agreement.id,
      loadId: agreement.load.id,
      version: agreement.version,
      status: agreement.status,
      rateCents: agreement.rateCents,
    }));
}
