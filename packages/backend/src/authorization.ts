import type { CallContext, Identity } from "@voice-freight/contracts/business";
import type { CallRecord, LiveSession, State } from "./model";
import { requireCondition } from "./model";

export type CallAccessRow = {
  identity: string;
  call: string | null;
  liveState: LiveSession["state"] | null;
  notice: string | null;
};

export function resolveIdentity(state: State, userId: string): Identity {
  const user = state.users.find((user): boolean => user.id === userId);
  requireCondition(user, "unauthenticated", "Sign in to continue.", 401);

  return user;
}

function requireCallAccess(user: Identity, call: CallRecord | null | undefined): CallRecord {
  requireCondition(
    call && (call.ownerId === user.id || user.role === "administrator"),
    "call_unavailable",
    "Call unavailable.",
    404,
  );
  return call;
}

export function selectCallAccess(binding: D1Database, context: CallContext): D1PreparedStatement {
  return binding
    .prepare(`SELECT users.data AS identity, calls.data AS call,
                     json_extract("liveSessions".data, '$.state') AS liveState,
                     json_extract("liveSessions".data, '$.notice') AS notice
              FROM users LEFT JOIN calls ON calls.id = ?
              LEFT JOIN "liveSessions" ON "liveSessions".id = calls.id
              WHERE users.id = ?`)
    .bind(context.callId, context.userId);
}

export function resolveCallAccess(row: CallAccessRow | null | undefined): {
  call: CallRecord;
  liveState: LiveSession["state"] | null;
  notice: string | null;
} {
  requireCondition(row, "unauthenticated", "Sign in to continue.", 401);
  const user = JSON.parse(row.identity) as Identity;
  const call = row.call === null ? null : (JSON.parse(row.call) as CallRecord);
  return { call: requireCallAccess(user, call), liveState: row.liveState, notice: row.notice };
}

export function authorizeCall(state: State, context: CallContext, active = true): CallRecord {
  const user = resolveIdentity(state, context.userId);
  const call = requireCallAccess(
    user,
    state.calls.find((call): boolean => call.id === context.callId),
  );

  if (active) {
    const session = state.liveSessions.find((entry): boolean => entry.id === call.id);

    requireCondition(
      call.record.endedAt === null && session?.state !== "ending" && session?.state !== "ended",
      "call_ended",
      "This call has ended.",
    );
  }

  return call;
}

export function authorizeAdministrator(state: State, userId: string): void {
  requireCondition(
    resolveIdentity(state, userId).role === "administrator",
    "forbidden",
    "Administrator access required.",
    403,
  );
}
