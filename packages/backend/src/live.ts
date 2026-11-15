import type { CallContext } from "@voice-freight/contracts/business";
import {
  groupTranscript,
  type LiveStatus,
  type Transcript,
  type TranscriptFragment,
} from "@voice-freight/contracts/live";
import { authorizeCall, resolveIdentity } from "./authorization";
import { initializeCall, completeCall } from "./calls";
import { requireCondition } from "./model";
import type { State } from "./model";
import { readState, transact } from "./repository";
import {
  calculateAvailableMicrodollars,
  calculateCallReservationMicrodollars,
  modelPrices,
  resolvePeriod,
  usageLimits,
} from "./spending";

export async function reserveLiveCall(
  binding: D1Database,
  userId: string,
  operationId: string,
  now = new Date().toISOString(),
  limits = usageLimits,
): Promise<{
  id: string;
}> {
  return transact(binding, (state): { id: string } => {
    resolveIdentity(state, userId);

    const previous = state.reservations.find(
      (entry): boolean => entry.ownerId === userId && entry.operationId === operationId,
    );

    if (previous) {
      return { id: previous.id };
    }

    for (const session of state.liveSessions.filter(
      (entry): boolean => entry.state === "connecting" && !entry.providerAttempted,
    )) {
      const reservation = state.reservations.find((entry): boolean => entry.id === session.id)!;

      if (Date.parse(now) - Date.parse(reservation.createdAt) < 30_000) {
        continue;
      }

      session.state = "ended";

      session.notice = "Call startup was abandoned before contacting the provider.";

      reservation.settled = true;

      completeCall(
        state,
        { callId: session.id, userId: reservation.ownerId },
        { connection: "Connection failed", transcriptComplete: false },
        now,
      );
    }

    const active = state.liveSessions.filter(
      (session): boolean => session.state !== "ended" || (session.providerAttempted && !session.providerClosed),
    );

    requireCondition(
      active.length < limits.globalConcurrency &&
        active.filter(
          (session): boolean => state.calls.find((call): boolean => call.id === session.id)?.ownerId === userId,
        ).length < limits.reviewerConcurrency,
      "concurrent_limit",
      "Another call is active or waiting for confirmed termination. Try again after it finishes.",
    );

    const today = state.reservations.filter((entry): boolean => entry.createdAt.slice(0, 10) === now.slice(0, 10));

    requireCondition(
      today.length < limits.globalDailyCalls &&
        today.filter((entry): boolean => entry.ownerId === userId).length < limits.reviewerDailyCalls,
      "daily_limit",
      "Daily call limit reached. Calls renew at 00:00 UTC.",
    );

    const callReservationMicrodollars = calculateCallReservationMicrodollars(limits.maximumCallSeconds);

    requireCondition(
      calculateAvailableMicrodollars(state, now) >= callReservationMicrodollars,
      "budget_exhausted",
      `The shared $25 monthly allowance cannot cover another call. It renews on ${new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 1)).toISOString().slice(0, 10)} at 00:00 UTC.`,
    );

    const { id } = initializeCall(state, userId, now);

    state.reservations.push({
      id,
      ownerId: userId,
      operationId,
      createdAt: now,
      reservedMicrodollars: callReservationMicrodollars,
      chargedMicrodollars: 0,
      settled: false,
      prices: { ...modelPrices },
    });

    state.liveSessions.push({
      closingAt: null,
      id,
      maximumCallSeconds: limits.maximumCallSeconds,
      inactivitySeconds: limits.inactivitySeconds,
      providerId: null,
      state: "connecting",
      notice: null,
      providerAttempted: false,
      providerClosed: false,
      usageConfirmed: false,
      voiceSeconds: 0,
      lastInputAt: now,
      warned: false,
      gap: false,
      responseIds: [],
      completedResponseIds: [],
      continuations: {},
      processedEventIds: [],
      submittedCallIds: [],
      delegationCallIds: {},
      answerSdp: null,
    });

    return { id };
  });
}

export async function queryLiveStatus(binding: D1Database, context: CallContext): Promise<LiveStatus> {
  const { state } = await readState(binding);
  const call = authorizeCall(state, context, false);
  const session = state.liveSessions.find((entry): boolean => entry.id === call.id);
  requireCondition(session, "call_unavailable", "Live call unavailable.", 404);

  return {
    id: call.id,
    state: session.state,
    startedAt: call.record.startedAt,
    endedAt: call.record.endedAt,
    notice: session.notice,
  };
}

export async function queryTranscript(binding: D1Database, context: CallContext): Promise<Transcript> {
  const { state } = await readState(binding);
  const call = authorizeCall(state, context, false);
  return { fragments: collectTranscriptFragments(state, call.id) };
}

function collectTranscriptFragments(state: State, callId: string): TranscriptFragment[] {
  return state.transcriptFragments
    .filter((fragment): boolean => fragment.callId === callId)
    .sort((a, b): number => a.startMs - b.startMs || a.endMs - b.endMs || a.sequence - b.sequence)
    .map(({ id, speaker, startMs, endMs, text }): TranscriptFragment => ({ id, speaker, startMs, endMs, text }));
}

export function collectTranscript(state: State, callId: string): TranscriptFragment[] {
  return groupTranscript(collectTranscriptFragments(state, callId));
}

export async function prepareBudgetFixture(
  binding: D1Database,
  scenario: string,
  now = new Date().toISOString(),
): Promise<void> {
  if (scenario !== "budget-start") {
    return;
  }

  await transact(binding, (state): void => {
    const id = resolvePeriod(now);
    const period = state.spendingPeriods.find((entry): boolean => entry.id === id);

    if (period) {
      period.spentMicrodollars = Math.max(period.spentMicrodollars, 24_999_999);
    } else {
      state.spendingPeriods.push({ id, spentMicrodollars: 24_999_999 });
    }
  });
}
