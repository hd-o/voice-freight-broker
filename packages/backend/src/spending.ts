import type { State, ModelPrices } from "./model";
import { requireCondition } from "./model";
import { z } from "zod";

export const monthlyLimitMicrodollars = 25_000_000;
export const modelPrices: ModelPrices = {
  version: "openai-2026-11-13",
  voiceMicrodollarsPerMinute: 50_000,
  inputMicrodollarsPerMillionTokens: 100_000,
  cachedInputMicrodollarsPerMillionTokens: 10_000,
  outputMicrodollarsPerMillionTokens: 500_000,
};
export const maximumCallSeconds = 600;
export const maximumResponseCount = 32;
export const maximumOutputTokens = 2048;
export const maximumContinuationCount = 4;
// Reserve for the model's entire context, even though this demo uses much less.
export const maximumResponseMicrodollars = Math.ceil(
  (1_050_000 * modelPrices.inputMicrodollarsPerMillionTokens +
    maximumOutputTokens * modelPrices.outputMicrodollarsPerMillionTokens) /
    1_000_000,
);
export const shutdownHeadroomMicrodollars =
  maximumResponseMicrodollars * 2 + 50_000;
export function calculateCallReservationMicrodollars(
  durationSeconds = maximumCallSeconds,
) {
  return Math.ceil(
    ((durationSeconds * modelPrices.voiceMicrodollarsPerMinute) / 60 +
      maximumResponseCount * maximumResponseMicrodollars +
      shutdownHeadroomMicrodollars) *
      1.25,
  );
}
export const callReservationMicrodollars =
  calculateCallReservationMicrodollars();

export const usageLimits = {
  maximumCallSeconds,
  inactivitySeconds: 60,
  reviewerConcurrency: 1,
  globalConcurrency: 2,
  reviewerDailyCalls: 6,
  globalDailyCalls: 40,
};
export type UsageConfiguration = {
  CALL_DURATION_SECONDS?: string;
  CALL_INACTIVITY_SECONDS?: string;
  REVIEWER_CONCURRENT_CALLS?: string;
  GLOBAL_CONCURRENT_CALLS?: string;
  REVIEWER_DAILY_CALLS?: string;
  GLOBAL_DAILY_CALLS?: string;
};
export function resolveUsageLimits(configuration: UsageConfiguration) {
  const limit = z.coerce.number().int().positive().max(10_000);
  return {
    maximumCallSeconds: limit.parse(
      configuration.CALL_DURATION_SECONDS ?? usageLimits.maximumCallSeconds,
    ),
    inactivitySeconds: limit.parse(
      configuration.CALL_INACTIVITY_SECONDS ?? usageLimits.inactivitySeconds,
    ),
    reviewerConcurrency: limit.parse(
      configuration.REVIEWER_CONCURRENT_CALLS ??
        usageLimits.reviewerConcurrency,
    ),
    globalConcurrency: limit.parse(
      configuration.GLOBAL_CONCURRENT_CALLS ?? usageLimits.globalConcurrency,
    ),
    reviewerDailyCalls: limit.parse(
      configuration.REVIEWER_DAILY_CALLS ?? usageLimits.reviewerDailyCalls,
    ),
    globalDailyCalls: limit.parse(
      configuration.GLOBAL_DAILY_CALLS ?? usageLimits.globalDailyCalls,
    ),
  };
}

export function resolvePeriod(now: string) {
  return now.slice(0, 7);
}

export function calculateAvailableMicrodollars(state: State, now: string) {
  const spentMicrodollars =
    state.spendingPeriods.find((period) => period.id === resolvePeriod(now))
      ?.spentMicrodollars ?? 0;
  // Unresolved reservations carry forward, including those from earlier months.
  const reservedMicrodollars = state.reservations
    .filter((reservation) => !reservation.settled)
    .reduce(
      (totalMicrodollars, reservation) =>
        totalMicrodollars +
        Math.max(
          0,
          reservation.reservedMicrodollars - reservation.chargedMicrodollars,
        ),
      0,
    );
  return monthlyLimitMicrodollars - spentMicrodollars - reservedMicrodollars;
}

export function chargeUsage(
  state: State,
  callId: string,
  id: string,
  periodId: string,
  costMicrodollars: number,
) {
  requireCondition(
    Number.isSafeInteger(costMicrodollars) && costMicrodollars >= 0,
    "accounting_unavailable",
    "Usage accounting is unavailable.",
    503,
  );
  const previous = state.providerUsage.find((usage) => usage.id === id);
  if (previous) {
    requireCondition(
      previous.callId === callId &&
        previous.periodId === periodId &&
        previous.costMicrodollars === costMicrodollars,
      "usage_conflict",
      "Provider usage conflicts with saved accounting.",
      503,
    );
    return;
  }
  const reservation = state.reservations.find((entry) => entry.id === callId);
  requireCondition(
    reservation,
    "accounting_unavailable",
    "A spending reservation is required.",
    503,
  );
  let period = state.spendingPeriods.find((entry) => entry.id === periodId);
  if (!period) {
    period = { id: periodId, spentMicrodollars: 0 };
    state.spendingPeriods.push(period);
  }
  period.spentMicrodollars += costMicrodollars;
  reservation.chargedMicrodollars += costMicrodollars;
  state.providerUsage.push({ id, callId, periodId, costMicrodollars });
}

export function chargeVoice(state: State, callId: string, seconds: number) {
  const session = state.liveSessions.find((entry) => entry.id === callId);
  const call = state.calls.find((entry) => entry.id === callId);
  const reservation = state.reservations.find((entry) => entry.id === callId);
  requireCondition(
    session && call && reservation && Number.isFinite(seconds) && seconds >= 0,
    "accounting_unavailable",
    "Invalid voice usage.",
    503,
  );
  if (seconds <= session.voiceSeconds) return;
  // Split cumulative voice duration at UTC month boundaries. Round the cumulative
  // cost per period, so fragmented updates never inflate the bill.
  const origin = Date.parse(call.record.startedAt);
  let cursor = origin;
  const end = origin + seconds * 1000;
  while (cursor < end) {
    const date = new Date(cursor);
    const boundary = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const periodEnd = Math.min(boundary, end);
    const periodId = resolvePeriod(date.toISOString());
    const cumulativeMicrodollars = Math.ceil(
      ((periodEnd - cursor) * reservation.prices.voiceMicrodollarsPerMinute) /
        60_000,
    );
    const id = `${callId}:voice:${periodId}`;
    const existing = state.providerUsage.find((entry) => entry.id === id);
    const previousMicrodollars = existing?.costMicrodollars ?? 0;
    if (cumulativeMicrodollars > previousMicrodollars) {
      chargeUsage(
        state,
        callId,
        `${id}:${seconds}`,
        periodId,
        cumulativeMicrodollars - previousMicrodollars,
      );
      const recorded = state.providerUsage.pop()!;
      if (existing) existing.costMicrodollars = cumulativeMicrodollars;
      else
        state.providerUsage.push({
          ...recorded,
          id,
          costMicrodollars: cumulativeMicrodollars,
        });
    }
    cursor = periodEnd;
  }
  session.voiceSeconds = seconds;
}

export function calculateResponseCostMicrodollars(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  prices: ModelPrices = modelPrices,
) {
  requireCondition(
    [inputTokens, cachedInputTokens, outputTokens].every(
      (tokens) => Number.isSafeInteger(tokens) && tokens >= 0,
    ) && cachedInputTokens <= inputTokens,
    "accounting_unavailable",
    "Delegated usage is unavailable.",
    503,
  );
  return Math.ceil(
    ((inputTokens - cachedInputTokens) *
      prices.inputMicrodollarsPerMillionTokens +
      cachedInputTokens * prices.cachedInputMicrodollarsPerMillionTokens +
      outputTokens * prices.outputMicrodollarsPerMillionTokens) /
      1_000_000,
  );
}
