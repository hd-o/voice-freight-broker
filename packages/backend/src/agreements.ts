import type { State, Agreement } from "./model";
import { requireCondition } from "./model";
import { checkAvailability } from "./inventory";
import { issueQuote, requireQuote } from "./negotiations";
import { requireEvidence } from "./evidence";

export function beginRenegotiation(
  state: State,
  callId: string,
  agreementId: string,
) {
  const agreement = state.agreements.find(
    (agreement) =>
      agreement.id === agreementId &&
      agreement.callId === callId &&
      agreement.status === "effective",
  );
  requireCondition(
    agreement,
    "agreement_unavailable",
    "Only this active call's effective agreements may be replaced.",
  );
  return issueQuote(state, callId, agreement.load.id, agreement.id);
}

export function confirmHandoff(
  state: State,
  callId: string,
  quoteId: string,
  evidence: { readbackId: string; callerId: string },
) {
  const { call, quote } = requireQuote(state, callId, quoteId);
  requireEvidence(state, callId, "handoff", quoteId, evidence);
  requireCondition(
    checkAvailability(state, quote.loadId, quote.replacementId),
    "load_unavailable",
    "Another call secured this load. Choose another load.",
  );
  const previous = quote.replacementId
    ? state.agreements.find(
        (agreement) =>
          agreement.id === quote.replacementId &&
          agreement.callId === callId &&
          agreement.status === "effective",
      )
    : null;
  requireCondition(
    !quote.replacementId || previous,
    "agreement_unavailable",
    "The replacement target is no longer effective.",
  );
  const load = call.record.loads.find((load) => load.id === quote.loadId)!;
  const agreement: Agreement = {
    evidenceAfterMs: Math.max(
      0,
      ...state.transcriptFragments
        .filter((entry) => entry.callId === callId)
        .map((entry) => entry.endMs),
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
  if (previous) previous.status = "superseded";
  state.agreements.push(agreement);
  quote.valid = false;
  call.quoteId = null;
  synchronizeAgreements(state, callId);
  return {
    agreementId: agreement.id,
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
) {
  requireEvidence(state, callId, "cancel", agreementId, evidence);
  const agreement = state.agreements.find(
    (agreement) =>
      agreement.id === agreementId &&
      agreement.callId === callId &&
      agreement.status === "effective",
  )!;
  agreement.status = "cancelled";
  agreement.cancellationEvidence = evidence;
  const call = state.calls.find((call) => call.id === callId)!;
  for (const quote of state.quotes.filter(
    (quote) => quote.replacementId === agreementId,
  )) {
    quote.valid = false;
    if (call.quoteId === quote.id) call.quoteId = null;
  }
  synchronizeAgreements(state, callId);
  return { agreementId, status: "cancelled", released: true };
}

export function synchronizeAgreements(state: State, callId: string) {
  const call = state.calls.find((call) => call.id === callId)!;
  call.record.agreements = state.agreements
    .filter((agreement) => agreement.callId === callId)
    .map((agreement) => ({
      id: agreement.id,
      loadId: agreement.load.id,
      version: agreement.version,
      status: agreement.status,
      rateCents: agreement.rateCents,
    }));
}
