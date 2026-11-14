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
  transcript: z.array(
    z.object({
      id: z.string(),
      speaker: z.enum(["carrier", "broker"]),
      startMs: z.number(),
      endMs: z.number(),
      text: z.string(),
    }),
  ),
});

export type LiveStatus = z.infer<typeof liveStatusSchema>;
