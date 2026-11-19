import { z } from "zod";

export const liveStartSchema = z.strictObject({
  operationId: z.string().uuid(),
  offerSdp: z.string().min(1).max(100_000),
});

export const liveConnectionSchema = z.object({
  id: z.string(),
  answerSdp: z.string(),
  provider: z.enum(["openai", "stub"]),
});

export const liveStatusSchema = z.object({
  id: z.string(),
  state: z.enum(["connecting", "connected", "ending", "ended"]),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  notice: z.string().nullable(),
});

export type LiveStatus = z.infer<typeof liveStatusSchema>;

export const transcriptEventSchema = z
  .object({
    type: z.enum(["session.input_transcript.delta", "session.output_transcript.delta"]),
    event_id: z.string(),
    delta: z.string().max(8000),
    start_ms: z.number().nonnegative(),
    end_ms: z.number().nonnegative(),
  })
  .refine((event): boolean => event.end_ms >= event.start_ms);

export const transcriptFragmentSchema = z.object({
  id: z.string(),
  speaker: z.enum(["carrier", "broker"]),
  startMs: z.number(),
  endMs: z.number(),
  text: z.string(),
});

export const transcriptSchema = z.object({
  fragments: z.array(transcriptFragmentSchema),
  cursor: z.number().int().min(-1).optional(),
});
export type TranscriptFragment = z.infer<typeof transcriptFragmentSchema>;
export type Transcript = z.infer<typeof transcriptSchema>;

export function groupTranscript(fragments: readonly TranscriptFragment[]): TranscriptFragment[] {
  const groups: TranscriptFragment[] = [];

  for (const fragment of fragments) {
    const previous = groups.at(-1);

    if (previous?.speaker === fragment.speaker && fragment.startMs - previous.endMs <= 1500) {
      previous.text += fragment.text;
      previous.endMs = Math.max(previous.endMs, fragment.endMs);
    } else {
      groups.push({ ...fragment });
    }
  }

  return groups;
}
