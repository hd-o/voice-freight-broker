import { callsSchema } from "@voice-freight/contracts/calls";
import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { authorizeCall, resolveIdentity } from "./authorization";
import { readState } from "./repository";
import type { CallContext } from "@voice-freight/contracts/business";

export async function queryDashboard(binding: D1Database, userId: string) {
  const { state } = await readState(binding);
  const user = resolveIdentity(state, userId);
  const calls = callsSchema.parse(
    state.calls
      .filter(
        (call) => call.ownerId === user.id || user.role === "administrator",
      )
      .map((call) => call.finalSnapshot ?? call.record)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  );
  return { calls, report: summarizeCalls(calls) };
}

export async function queryCall(binding: D1Database, context: CallContext) {
  const { state } = await readState(binding);
  const call = authorizeCall(state, context, false);
  return call.finalSnapshot ?? call.record;
}
