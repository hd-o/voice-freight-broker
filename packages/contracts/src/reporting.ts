import type { Call } from "./calls";

export function listFinalAgreements(call: Call): Call["agreements"] {
  return call.agreements.filter((agreement): boolean => agreement.status === "effective");
}

export function describeOutcome(call: Call): "Agreement reached" | Call["outcomeReason"] {
  return listFinalAgreements(call).length > 0 ? "Agreement reached" : call.outcomeReason;
}

export function summarizeCalls(calls: readonly Call[]): {
  callCount: number;
  durationCount: number;
  averageDurationSeconds: number | null;
  matchedCallCount: number;
  agreementCallCount: number;
  agreementRate: number | null;
  finalAgreementCount: number;
  averageVarianceCents: number | null;
  sentiments: { label: "Positive" | "Neutral" | "Negative" | "Unknown"; count: number; percentage: number }[];
} {
  const endedCalls = calls.filter((call): boolean => call.endedAt !== null);

  const durations = calls.flatMap((call): number[] =>
    call.endedAt === null ? [] : [(Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000],
  );

  const matchedCalls = endedCalls.filter(
    (call): boolean =>
      listFinalAgreements(call).length > 0 ||
      (call.eligibility === "Eligible" && call.matched && !call.unresolvedError),
  );

  const agreementCalls = matchedCalls.filter((call): boolean => listFinalAgreements(call).length > 0);

  const variances = endedCalls.flatMap((call): number[] =>
    listFinalAgreements(call).map((agreement): number => {
      const load = call.loads.find((load): boolean => load.id === agreement.loadId);

      if (!load) {
        throw new Error("Agreement load snapshot is unavailable");
      }

      return agreement.rateCents - load.postedRateCents;
    }),
  );

  const sentiments = (["Positive", "Neutral", "Negative", "Unknown"] as const).map(
    (label): { label: typeof label; count: number; percentage: number } => {
      const count = calls.filter((call): boolean => call.analysis.sentiment === label).length;

      return {
        label,
        count,
        percentage: calls.length ? Math.round((count / calls.length) * 1000) / 10 : 0,
      };
    },
  );

  return {
    callCount: calls.length,
    durationCount: durations.length,
    averageDurationSeconds: durations.length
      ? durations.reduce((sum, duration): number => sum + duration, 0) / durations.length
      : null,
    matchedCallCount: matchedCalls.length,
    agreementCallCount: agreementCalls.length,
    agreementRate: matchedCalls.length ? agreementCalls.length / matchedCalls.length : null,
    finalAgreementCount: variances.length,
    averageVarianceCents: variances.length
      ? variances.reduce((sum, variance): number => sum + variance, 0) / variances.length
      : null,
    sentiments,
  };
}
