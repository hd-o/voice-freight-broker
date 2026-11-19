import type { CallContext } from "@voice-freight/contracts/business";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  groupTranscript,
  type LiveStatus,
  type Transcript,
  type TranscriptFragment,
} from "@voice-freight/contracts/live";
import { resolveCallAccess, resolveIdentity, selectCallAccess, type CallAccessRow } from "./authorization";
import { initializeCall } from "./calls";
import { requireCondition } from "./model";
import type { CallRecord, LiveSession, Reservation, SpendingPeriod, State } from "./model";
import { localDailyQuotaId } from "./quotas";
import { transact } from "./repository";
import { calls, liveSessions } from "./schema";
import {
  calculateAvailableMicrodollars,
  calculateCallReservationMicrodollars,
  calculateReservationHold,
  fastModelPrices,
  monthlyLimitMicrodollars,
  resolveCallSpending,
  resolvePeriod,
  usageLimits,
} from "./spending";

export async function reserveLiveCall(
  binding: D1Database,
  userId: string,
  operationId: string,
  now = new Date().toISOString(),
  limits = usageLimits,
  environment = "prod",
  callId?: string,
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

    const quotaVersion =
      environment === "local"
        ? state.quotaResets.find((entry): boolean => entry.id === localDailyQuotaId)?.version
        : undefined;

    const today = state.reservations.filter(
      (entry): boolean =>
        (entry.kind ?? "call") === "call" &&
        entry.createdAt.slice(0, 10) === now.slice(0, 10) &&
        (environment !== "local" || entry.dailyQuotaVersion === quotaVersion),
    );

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

    const { id } = initializeCall(state, userId, now, callId);

    const reservation: Reservation = {
      ...(quotaVersion ? { dailyQuotaVersion: quotaVersion } : {}),
      id,
      ownerId: userId,
      operationId,
      createdAt: now,
      reservedMicrodollars: callReservationMicrodollars,
      chargedMicrodollars: 0,
      settled: false,
      prices: { ...fastModelPrices },
    };

    reservation.callSpending = resolveCallSpending(
      reservation,
      { id, maximumCallSeconds: limits.maximumCallSeconds },
      [],
    );
    state.reservations.push(reservation);

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

export async function findLiveReservation(
  binding: D1Database,
  userId: string,
  operationId: string,
): Promise<{ id: string } | null> {
  return binding
    .prepare(
      "SELECT id FROM reservations WHERE json_extract(data, '$.ownerId') = ? AND json_extract(data, '$.operationId') = ?",
    )
    .bind(userId, operationId)
    .first<{ id: string }>();
}

export async function findLiveSession(binding: D1Database, callId: string): Promise<LiveSession | null> {
  const row = await binding.prepare('SELECT data FROM "liveSessions" WHERE id = ?').bind(callId).first<string>("data");
  return row === null ? null : (JSON.parse(row) as LiveSession);
}

export async function readLiveCall(
  binding: D1Database,
  context: CallContext,
): Promise<{ call: CallRecord; session: LiveSession }> {
  const row = await drizzle(binding)
    .select({ call: calls.data, session: liveSessions.data })
    .from(calls)
    .innerJoin(liveSessions, eq(liveSessions.id, calls.id))
    .where(eq(calls.id, context.callId))
    .get();

  requireCondition(row?.call.ownerId === context.userId, "call_unavailable", "Call unavailable.", 404);
  return row;
}

export async function readLiveAllowance(
  binding: D1Database,
  context: CallContext,
  now: string,
): Promise<{ session: LiveSession; reservation: Reservation | null; availableMicrodollars: number }> {
  const [callResult, reservationsResult, periodResult] = await binding.batch([
    binding
      .prepare(
        `SELECT calls.data AS call, "liveSessions".data AS session, reservations.data AS reservation
         FROM calls JOIN "liveSessions" ON "liveSessions".id = calls.id
         LEFT JOIN reservations ON reservations.id = calls.id WHERE calls.id = ?`,
      )
      .bind(context.callId),
    binding.prepare(`SELECT data FROM reservations WHERE json_extract(data, '$.settled') IS NOT 1`),
    binding.prepare("SELECT data FROM spendingPeriods WHERE id = ?").bind(resolvePeriod(now)),
  ]);

  const row = callResult.results[0] as { call: string; session: string; reservation: string | null } | undefined;
  const call = row ? (JSON.parse(row.call) as CallRecord) : null;
  requireCondition(call?.ownerId === context.userId, "call_unavailable", "Call unavailable.", 404);
  requireCondition(row, "call_unavailable", "Call unavailable.", 404);
  const session = JSON.parse(row.session) as LiveSession;
  const reservation = row.reservation ? (JSON.parse(row.reservation) as Reservation) : null;
  const periodRow = periodResult.results[0] as { data: string } | undefined;
  const period = periodRow ? (JSON.parse(periodRow.data) as SpendingPeriod) : undefined;
  const holds = (reservationsResult.results as { data: string }[]).reduce(
    (total, entry): number => total + calculateReservationHold(JSON.parse(entry.data) as Reservation),
    0,
  );

  return {
    session,
    reservation,
    availableMicrodollars: monthlyLimitMicrodollars - (period?.spentMicrodollars ?? 0) - holds,
  };
}

export async function queryLiveStatus(binding: D1Database, context: CallContext): Promise<LiveStatus> {
  const row = await selectCallAccess(binding, context).first<CallAccessRow>();
  const { call, liveState, notice } = resolveCallAccess(row);
  requireCondition(liveState, "call_unavailable", "Live call unavailable.", 404);

  return {
    id: call.id,
    state: liveState,
    startedAt: call.record.startedAt,
    endedAt: call.record.endedAt,
    notice,
  };
}

export async function queryTranscript(binding: D1Database, context: CallContext, after?: number): Promise<Transcript> {
  const [access, transcript] = await binding.batch([
    selectCallAccess(binding, context),
    after === undefined
      ? selectTranscriptFragments(binding, context.callId)
      : binding
          .prepare(
            `SELECT data FROM "transcriptFragments" WHERE json_extract(data, '$.callId') = ?
             AND json_extract(data, '$.sequence') > ? ORDER BY json_extract(data, '$.sequence')`,
          )
          .bind(context.callId, after),
  ]);

  resolveCallAccess(access.results[0] as CallAccessRow | undefined);
  const rows = transcript.results as { data: string }[];
  const fragments = parseTranscriptFragments(rows);

  if (after === undefined) {
    return { fragments };
  }

  const last = rows.at(-1);
  const cursor = last ? (JSON.parse(last.data) as State["transcriptFragments"][number]).sequence : after;
  return { fragments, cursor };
}

export function selectTranscriptFragments(binding: D1Database, callId: string): D1PreparedStatement {
  return binding
    .prepare(`SELECT data FROM "transcriptFragments" WHERE json_extract(data, '$.callId') = ?`)
    .bind(callId);
}

export function parseTranscriptFragments(rows: { data: string }[]): TranscriptFragment[] {
  return orderTranscriptFragments(rows.map((row): State["transcriptFragments"][number] => JSON.parse(row.data)));
}

function orderTranscriptFragments(fragments: State["transcriptFragments"]): TranscriptFragment[] {
  return fragments
    .sort((a, b): number => a.startMs - b.startMs || a.endMs - b.endMs || a.sequence - b.sequence)
    .map(({ id, speaker, startMs, endMs, text }): TranscriptFragment => ({ id, speaker, startMs, endMs, text }));
}

export function collectTranscript(state: State, callId: string): TranscriptFragment[] {
  const fragments = state.transcriptFragments.filter((fragment): boolean => fragment.callId === callId);
  return groupTranscript(orderTranscriptFragments(fragments));
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
