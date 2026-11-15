import type { Call } from "@voice-freight/contracts/calls";
import { callsSchema } from "@voice-freight/contracts/calls";
import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { authorizeCall, resolveIdentity } from "./authorization";
import { readState } from "./repository";
import type { CallContext } from "@voice-freight/contracts/business";
import type { State, CallRecord } from "./model";
import { collectTranscript } from "./live";

function projectCall(state: State, call: CallRecord): Call {
  const record = call.finalSnapshot ?? call.record;

  if (!state.liveSessions.some((entry): boolean => entry.id === call.id)) {
    return record;
  }

  return {
    ...record,
    transcript: {
      complete: call.record.transcript.complete,
      entries: collectTranscript(state, call.id).map((entry): Call["transcript"]["entries"][number] => ({
        id: entry.id,
        speaker: entry.speaker,
        offsetSeconds: Math.floor(entry.startMs / 1000),
        text: entry.text,
      })),
    },
  };
}

export async function queryDashboard(
  binding: D1Database,
  userId: string,
): Promise<{ calls: Call[]; report: ReturnType<typeof summarizeCalls> }> {
  const { state } = await readState(binding);
  const user = resolveIdentity(state, userId);

  const calls = callsSchema.parse(
    state.calls
      .filter((call): boolean => call.ownerId === user.id || user.role === "administrator")
      .map((call): Call => projectCall(state, call))
      .sort((a, b): number => b.startedAt.localeCompare(a.startedAt)),
  );

  return { calls, report: summarizeCalls(calls) };
}

export async function queryCall(binding: D1Database, context: CallContext): Promise<Call> {
  const { state } = await readState(binding);
  const call = authorizeCall(state, context, false);

  return projectCall(state, call);
}
