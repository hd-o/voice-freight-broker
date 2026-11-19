import type { Call } from "@voice-freight/contracts/calls";
import { callsSchema } from "@voice-freight/contracts/calls";
import { groupTranscript, type TranscriptFragment } from "@voice-freight/contracts/live";
import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { resolveCallAccess, resolveIdentity, selectCallAccess, type CallAccessRow } from "./authorization";
import { readState } from "./repository";
import type { CallContext } from "@voice-freight/contracts/business";
import type { Analysis, CallRecord } from "./model";
import { collectTranscript, parseTranscriptFragments, selectTranscriptFragments } from "./live";

function projectCall(call: CallRecord, analysis?: Analysis, transcript?: TranscriptFragment[]): Call {
  const snapshot = call.finalSnapshot ?? call.record;
  const record: Call = {
    ...snapshot,
    analysis: analysis?.result
      ? { ...analysis.result, version: analysis.version }
      : analysis
        ? {
            version: analysis.version,
            status: analysis.status,
            sentiment: "Unknown",
            summary: null,
            reason: analysis.reason,
            retryAt: analysis.nextAttemptAt,
          }
        : snapshot.analysis,
  };

  if (!transcript) {
    return record;
  }

  return {
    ...record,
    transcript: {
      complete: call.record.transcript.complete,
      entries: transcript.map((entry): Call["transcript"]["entries"][number] => ({
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
      .map((call): Call => {
        const analysis = state.analysis.find((entry): boolean => entry.callId === call.id);

        const transcript = state.liveSessions.some((entry): boolean => entry.id === call.id)
          ? collectTranscript(state, call.id)
          : undefined;

        return projectCall(call, analysis, transcript);
      })
      .sort((a, b): number => b.startedAt.localeCompare(a.startedAt)),
  );

  return { calls, report: summarizeCalls(calls) };
}

export async function queryCall(binding: D1Database, context: CallContext): Promise<Call> {
  // Finalization writes the call and its analysis together. Read one snapshot
  // so the page cannot combine the active call with its finalized analysis.
  const [access, analysis, fragments] = await binding.batch([
    selectCallAccess(binding, context),
    binding.prepare("SELECT data FROM analysis WHERE id = ?").bind(context.callId),
    selectTranscriptFragments(binding, context.callId),
  ]);

  const { call, liveState } = resolveCallAccess(access.results[0] as CallAccessRow | undefined);
  const analysisRow = analysis.results[0] as { data: string } | undefined;
  const job = analysisRow ? (JSON.parse(analysisRow.data) as Analysis) : undefined;
  const transcript = liveState
    ? groupTranscript(parseTranscriptFragments(fragments.results as { data: string }[]))
    : undefined;
  return projectCall(call, job, transcript);
}
