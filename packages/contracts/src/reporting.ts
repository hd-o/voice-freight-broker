import type { Call } from "./calls";

export function listFinalAgreements(call: Call) {
  return call.agreements.filter(
    (agreement) => agreement.status === "effective",
  );
}

export function describeOutcome(call: Call) {
  return listFinalAgreements(call).length > 0
    ? "Agreement reached"
    : call.outcomeReason;
}

export function summarizeCalls(calls: readonly Call[]) {
  const endedCalls = calls.filter((call) => call.endedAt !== null);
  const durations = calls.flatMap((call) =>
    call.endedAt === null
      ? []
      : [(Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000],
  );
  const matchedCalls = endedCalls.filter(
    (call) =>
      listFinalAgreements(call).length > 0 ||
      (call.eligibility === "Eligible" &&
        call.matched &&
        !call.unresolvedError),
  );
  const agreementCalls = matchedCalls.filter(
    (call) => listFinalAgreements(call).length > 0,
  );
  const variances = endedCalls.flatMap((call) =>
    listFinalAgreements(call).map((agreement) => {
      const load = call.loads.find((load) => load.id === agreement.loadId);

      if (!load) {
        throw new Error("Agreement load snapshot is unavailable");
      }

      return agreement.rateCents - load.postedRateCents;
    }),
  );
  const sentiments = (
    ["Positive", "Neutral", "Negative", "Unknown"] as const
  ).map((label) => {
    const count = calls.filter(
      (call) => call.analysis.sentiment === label,
    ).length;

    return {
      label,
      count,
      percentage: calls.length
        ? Math.round((count / calls.length) * 1000) / 10
        : 0,
    };
  });

  return {
    callCount: calls.length,
    durationCount: durations.length,
    averageDurationSeconds: durations.length
      ? durations.reduce((sum, duration) => sum + duration, 0) /
        durations.length
      : null,
    matchedCallCount: matchedCalls.length,
    agreementCallCount: agreementCalls.length,
    agreementRate: matchedCalls.length
      ? agreementCalls.length / matchedCalls.length
      : null,
    finalAgreementCount: variances.length,
    averageVarianceCents: variances.length
      ? variances.reduce((sum, variance) => sum + variance, 0) /
        variances.length
      : null,
    sentiments,
  };
}
