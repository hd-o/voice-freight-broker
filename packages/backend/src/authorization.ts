import type { CallContext, Identity } from "@voice-freight/contracts/business";
import type { State } from "./model";
import { requireCondition } from "./model";

export function resolveIdentity(state: State, userId: string): Identity {
  const user = state.users.find((user): boolean => user.id === userId);
  requireCondition(user, "unauthenticated", "Sign in to continue.", 401);

  return user;
}

export function authorizeCall(state: State, context: CallContext, active = true): import("./model").CallRecord {
  const user = resolveIdentity(state, context.userId);
  const call = state.calls.find((call): boolean => call.id === context.callId);

  requireCondition(
    call && (call.ownerId === user.id || user.role === "administrator"),
    "call_unavailable",
    "Call unavailable.",
    404,
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
