import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { callSchema } from "@voice-freight/contracts/calls";
import { groupTranscript, transcriptFragmentSchema, type TranscriptFragment } from "@voice-freight/contracts/live";
import { CommandError } from "./errors.ts";

const recordSchema = z.object({ transcript: callSchema.shape.transcript });
const callRecordSchema = z.object({ record: recordSchema, finalSnapshot: recordSchema.nullable() });
const fragmentSchema = transcriptFragmentSchema.extend({ sequence: z.number().int().nonnegative() });

export type CallTranscript = { callId: string; complete: boolean; entries: TranscriptFragment[] };

export function queryTranscript(database: DatabaseSync, callId: string): CallTranscript {
  const row = database.prepare("SELECT data FROM calls WHERE id = ?").get(callId);

  if (!row) {
    throw new CommandError(
      "call_missing",
      `Call not found: ${callId}`,
      "Check the call ID and selected local database.",
      3,
    );
  }

  try {
    const call = callRecordSchema.parse(JSON.parse(z.string().parse(row.data)));
    const session = database.prepare("SELECT id FROM liveSessions WHERE id = ?").get(callId);

    if (!session) {
      const transcript = (call.finalSnapshot ?? call.record).transcript;

      return {
        callId,
        complete: call.record.transcript.complete,
        entries: transcript.entries.map((entry): TranscriptFragment => ({
          id: entry.id,
          speaker: entry.speaker,
          startMs: entry.offsetSeconds * 1000,
          endMs: entry.offsetSeconds * 1000,
          text: entry.text,
        })),
      };
    }

    const fragments = database
      .prepare("SELECT data FROM transcriptFragments WHERE json_extract(data, '$.callId') = ?")
      .all(callId)
      .map((fragment): z.infer<typeof fragmentSchema> =>
        fragmentSchema.parse(JSON.parse(z.string().parse(fragment.data))),
      )
      .sort(
        (first, second): number =>
          first.startMs - second.startMs || first.endMs - second.endMs || first.sequence - second.sequence,
      )
      .map(({ id, speaker, startMs, endMs, text }): TranscriptFragment => ({ id, speaker, startMs, endMs, text }));

    return { callId, complete: call.record.transcript.complete, entries: groupTranscript(fragments) };
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw new CommandError(
        "transcript_invalid",
        `Stored transcript data is invalid for call ${callId}.`,
        "Inspect the call and transcriptFragments rows with db query.",
      );
    }

    throw error;
  }
}

export function formatTranscript(transcript: CallTranscript): string {
  const header = `Call ${transcript.callId} | Transcript ${transcript.complete ? "complete" : "incomplete"}`;
  const entries = transcript.entries.map((entry): string => {
    const seconds = Math.floor(entry.startMs / 1000);
    const timestamp = `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;

    return `[${timestamp}] ${entry.speaker}: ${entry.text.trim()}`;
  });

  return [header, ...(entries.length ? entries : ["No transcript entries saved."])].join("\n");
}
