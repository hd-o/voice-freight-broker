import type { CallContext } from "@voice-freight/contracts/business";
import { authorizeCall } from "./authorization";
import { requireCondition } from "./model";
import type { State } from "./model";
import { resolveTarget } from "./evidence";
import { normalizeSpeech, normalizeReadback, parseSpokenNumber, unitWords, tensWords } from "./speech";
import { describeLoad } from "./readbacks";

export function captureConfirmation(
  state: State,
  context: CallContext,
  action: "handoff" | "cancel",
  targetId: string,
) {
  const call = authorizeCall(state, context);
  const target = resolveTarget(state, call.id, action, targetId);
  const load = call.record.loads.find((entry) => entry.id === target.loadId);

  requireCondition(
    load && call.record.carrier,
    "evidence_required",
    "A verified carrier and selected load are required.",
  );

  const fragments = state.transcriptFragments
    .filter((entry) => entry.callId === call.id)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.sequence - b.sequence);

  // A confirmation must be the latest caller speech. Never search backward for
  // an earlier 'yes' after a correction or a different request.
  const lastCaller = fragments.findLastIndex((entry) => entry.speaker === "carrier");

  requireCondition(
    lastCaller >= 0,
    "evidence_required",
    "Ask for a clear spoken confirmation after the full read-back.",
  );

  let firstCaller = lastCaller;

  while (firstCaller > 0 && fragments[firstCaller - 1].speaker === "carrier") {
    firstCaller--;
  }

  const caller = fragments.slice(firstCaller, lastCaller + 1);
  const callerText = caller.map((entry) => entry.text).join("");

  const affirmative =
    /^(yes|yes please|yes confirmed|yes i confirm|i confirm|confirmed|that is correct|that s correct|correct|go ahead|yes go ahead)( thank you| thanks)?$/;

  requireCondition(
    affirmative.test(normalizeSpeech(callerText)),
    "evidence_required",
    "Confirmation is unclear. Read back the details and ask the caller to say yes or confirmed.",
  );

  const latestQuote = state.quotes.find((entry) => entry.id === targetId);
  const agreement = state.agreements.find((entry) => entry.id === targetId);
  const evidenceAfterMs = latestQuote?.evidenceAfterMs ?? agreement?.evidenceAfterMs ?? 0;

  let firstBroker = firstCaller - 1;

  requireCondition(
    firstBroker >= 0 && fragments[firstBroker].speaker === "broker",
    "evidence_required",
    "The caller must confirm after the broker read-back.",
  );

  while (
    firstBroker > 0 &&
    fragments[firstBroker - 1].speaker === "broker" &&
    fragments[firstBroker - 1].startMs >= evidenceAfterMs
  ) {
    firstBroker--;
  }

  const broker = fragments.slice(firstBroker, firstCaller);
  const brokerSpeech = broker.map((entry) => entry.text).join("");
  // Earlier bargaining may contain rejected prices or negation. Validate the
  // latest explicit read-back, without treating pauses as turn boundaries.
  const readbackStart = [
    ...brokerSpeech.matchAll(/(?:^|[.!?]\s+)please\s+confirm(?:\s+(?:cancellation|replacement))?[\s,:]+(?=\w)/gi),
  ].at(-1)?.index;
  const brokerText = readbackStart === undefined ? brokerSpeech : brokerSpeech.slice(readbackStart);
  const normalized = normalizeSpeech(brokerText.replace(/(?<=\d),(?=\d)/g, ""));

  const numericRates = [
    ...brokerText.matchAll(/\$\s*([\d,]+(?:\.\d{1,2})?)(?!\d|\.\d)|\b(?<![-\d.,])([\d,]+(?:\.\d{1,2})?)\s+dollars\b/gi),
  ].map((match) => Math.round(Number((match[1] ?? match[2]).replaceAll(",", "")) * 100));

  const numberWords = [...unitWords, ...tensWords, "hundred", "thousand", "and"].join("|");

  const spokenMatches = [
    ...normalized.matchAll(
      new RegExp(`\\b((?:(?:${numberWords})\\s+)+)dollars(?:\\s+and\\s+([a-z\\s]+?)\\s+cents)?\\b`, "g"),
    ),
  ];

  const spokenRates = spokenMatches.map((match) => {
    const dollars = parseSpokenNumber(match[1]);
    const cents = match[2] ? parseSpokenNumber(match[2]) : 0;

    return dollars !== null && cents !== null && cents < 100 ? dollars * 100 + cents : null;
  });

  const rates = [...numericRates, ...spokenRates];

  const hasRate =
    rates.length > 0 &&
    rates.every((rateCents) => rateCents === target.rateCents) &&
    (normalized.match(/\bcents\b/g)?.length ?? 0) === spokenMatches.filter((match) => match[2]).length;

  const hasCarrier = normalized.includes(normalizeSpeech(call.record.carrier.name));
  const spokenLabel = describeLoad(state, call.id, load).spokenLabel;
  const hasLoad =
    ` ${normalizeReadback(brokerText)} `.includes(` ${normalizeReadback(spokenLabel)} `) ||
    (readbackStart === undefined && normalized.includes(normalizeSpeech(load.reference)));
  const lastBroker = broker.at(-1)!;

  requireCondition(
    brokerText.length <= 8000 &&
      !/\b(not|never|maybe|instead|or|cannot|don t|can t|won t|minus|negative)\b/.test(normalized) &&
      !/[-−]\s*\$|\$\s*[-−]/.test(brokerText) &&
      hasCarrier &&
      hasLoad &&
      hasRate &&
      (action === "cancel" ? /\bcancel\w*\b/.test(normalized) : !/\bcancel\w*\b/.test(normalized)) &&
      (latestQuote?.replacementId
        ? /\breplace(?:ment)?\b/.test(normalized)
        : !/\breplace(?:ment)?\b/.test(normalized)) &&
      broker[0].startMs >= evidenceAfterMs &&
      caller[0].startMs >= lastBroker.endMs &&
      (!latestQuote || latestQuote.valid),
    "evidence_required",
    !hasCarrier
      ? "The carrier name is missing."
      : !hasLoad
        ? "The load description does not match."
        : !hasRate
          ? "The rate does not match."
          : "A fresh, non-overlapping read-back and confirmation are required.",
  );

  const readbackId = `${broker[0].id}:readback:${targetId}`;
  const callerId = `${caller[0].id}:confirmation:${targetId}`;

  state.evidence.push({
    id: readbackId,
    callId: call.id,
    ...target,
    recordedAt: new Date().toISOString(),
    speaker: "broker",
    text: brokerText,
    offsetSeconds: Math.floor(broker[0].startMs / 1000),
    action,
    targetId,
    confirmed: false,
  });

  state.evidence.push({
    id: callerId,
    callId: call.id,
    ...target,
    recordedAt: new Date().toISOString(),
    speaker: "carrier",
    text: callerText,
    offsetSeconds: Math.floor(caller[0].startMs / 1000),
    action,
    targetId,
    readbackId,
    confirmed: true,
  });

  return { readbackId, callerId };
}
