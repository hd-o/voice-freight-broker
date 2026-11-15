import type { State, Quote } from "./model";
import { requireCondition } from "./model";
import { checkAvailability } from "./inventory";
import { createReadback } from "./readbacks";

export function issueQuote(
  state: State,
  callId: string,
  loadId: string,
  replacementId: string | null = null,
): ReturnType<typeof describeQuote> {
  const call = state.calls.find((call): boolean => call.id === callId)!;
  const verification = call.verification;

  requireCondition(
    verification?.status === "eligible" && verification.carrierId,
    "verification_required",
    "Verify an eligible carrier first.",
  );

  const inventory = state.inventory.find((entry): boolean => entry.id === loadId);

  requireCondition(
    inventory && call.inventoryIds.includes(loadId),
    "load_unavailable",
    "Load is outside this call's inventory.",
  );

  requireCondition(checkAvailability(state, loadId, replacementId), "load_unavailable", "Load is already allocated.");

  let pair = state.negotiations.find(
    (pair): boolean => pair.carrierId === verification.carrierId && pair.loadId === loadId,
  );

  if (!pair) {
    pair = {
      id: crypto.randomUUID(),
      carrierId: verification.carrierId,
      loadId,
      policyVersion: "pricing-v1",
      version: 1,
      rateCents: inventory.load.postedRateCents,
      prices: [],
    };

    state.negotiations.push(pair);
  }

  for (const quote of state.quotes.filter((quote): boolean => quote.callId === callId)) {
    quote.valid = false;
  }

  const quote: Quote = {
    evidenceAfterMs: Math.max(
      0,
      ...state.transcriptFragments
        .filter((entry): boolean => entry.callId === callId)
        .map((entry): typeof entry.endMs => entry.endMs),
    ),
    id: crypto.randomUUID(),
    callId,
    carrierId: pair.carrierId,
    loadId,
    rateCents: pair.rateCents,
    pairVersion: pair.version,
    version: state.quotes.filter((quote): boolean => quote.callId === callId).length + 1,
    replacementId,
    valid: true,
  };

  state.quotes.push(quote);
  call.quoteId = quote.id;
  call.selectedLoadId = loadId;
  call.record.matched = true;

  if (!call.record.loads.some((load): boolean => load.id === loadId)) {
    call.record.loads.push(structuredClone(inventory.load));
  }

  return describeQuote(state, quote);
}

export function requireQuote(
  state: State,
  callId: string,
  quoteId: string,
): {
  call: import("./model").CallRecord;
  quote: Quote;
  pair: import("./model").Negotiation;
} {
  const call = state.calls.find((call): boolean => call.id === callId)!;

  const quote = state.quotes.find((quote): boolean => quote.id === quoteId && quote.callId === callId);

  requireCondition(
    quote &&
      quote.valid &&
      call.quoteId === quoteId &&
      call.selectedLoadId === quote.loadId &&
      call.verification?.carrierId === quote.carrierId,
    "stale_quote",
    "Select the load again for a fresh quote and confirmation.",
  );

  const pair = state.negotiations.find(
    (pair): boolean => pair.carrierId === quote.carrierId && pair.loadId === quote.loadId,
  )!;

  requireCondition(
    pair.version === quote.pairVersion,
    "stale_quote",
    "The shared negotiation changed. Request a fresh quote.",
  );

  return { call, quote, pair };
}

export function describeQuote(
  state: State,
  quote: Quote,
): {
  quoteId: string;
  readback: string;
  version: number;
  loadId: string;
  rateCents: number;
  usedRounds: number;
  remainingRounds: number;
} {
  const pair = state.negotiations.find(
    (pair): boolean => pair.carrierId === quote.carrierId && pair.loadId === quote.loadId,
  )!;

  return {
    quoteId: quote.id,
    readback: createReadback(
      state,
      quote.callId,
      state.inventory.find((entry): boolean => entry.id === quote.loadId)!.load,
      quote.rateCents,
      quote.replacementId ? "replace" : "handoff",
    ),
    version: quote.version,
    loadId: quote.loadId,
    rateCents: quote.rateCents,
    usedRounds: pair.prices.length,
    remainingRounds: 3 - pair.prices.length,
  };
}

export function evaluateOffer(
  state: State,
  callId: string,
  quoteId: string,
  amountCents: number,
): ReturnType<typeof describeQuote> & { decision: string } {
  const { call, quote, pair } = requireQuote(state, callId, quoteId);
  const inventory = state.inventory.find((entry): boolean => entry.id === quote.loadId)!;

  requireCondition(
    checkAvailability(state, quote.loadId, quote.replacementId),
    "load_unavailable",
    "Load is already allocated.",
  );

  const repeated = pair.prices.includes(amountCents);
  const exhausted = pair.prices.length === 3;
  let decision: string;

  if (repeated) {
    decision = "repeated_price";
  } else if (exhausted) {
    decision = "bargaining_exhausted";
  } else {
    pair.prices.push(amountCents);
    pair.version++;

    if (amountCents <= inventory.maximumCents) {
      pair.rateCents = amountCents;
      decision = "price_allowed";
    } else if (pair.prices.length < 3) {
      pair.rateCents += Math.floor((inventory.maximumCents - pair.rateCents) / 2);

      decision = "broker_counter";
    } else {
      decision = "bargaining_exhausted";
    }

    const load = call.record.loads.find((load): boolean => load.id === quote.loadId)!;
    load.negotiation.push({ kind: "Carrier offer", rateCents: amountCents });

    if (decision !== "bargaining_exhausted") {
      load.negotiation.push({
        kind: "Broker counter",
        rateCents: pair.rateCents,
      });
    }
  }

  const result =
    repeated || exhausted ? describeQuote(state, quote) : issueQuote(state, callId, quote.loadId, quote.replacementId);

  state.events.push({
    id: crypto.randomUUID(),
    callId,
    pairId: pair.id,
    amountCents,
    consumed: !repeated && !exhausted,
    decision,
    quoteId: result.quoteId,
  });

  return { ...result, decision };
}
