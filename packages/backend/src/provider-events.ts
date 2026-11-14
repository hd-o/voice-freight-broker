import { z } from "zod";
import type { CallContext } from "@voice-freight/contracts/business";
import { authorizeCall } from "./authorization";
import { requireCondition } from "./model";
import { transact } from "./repository";
import {
  chargeUsage,
  chargeVoice,
  calculateResponseCostMicrodollars,
  resolvePeriod,
} from "./spending";

export const providerEventSchema = z
  .object({ type: z.string(), event_id: z.string().optional() })
  .passthrough();
const transcriptEventSchema = providerEventSchema.extend({
  event_id: z.string(),
  delta: z.string().max(8000),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
});
const responseEventSchema = z.object({
  type: z.string(),
  response: z
    .object({
      id: z.string(),
      created_at: z.number().optional(),
      usage: z
        .object({
          input_tokens: z.number(),
          output_tokens: z.number(),
          input_tokens_details: z
            .object({ cached_tokens: z.number().optional() })
            .optional(),
        })
        .nullish(),
    })
    .passthrough(),
});

export async function ingestProviderEvent(
  binding: D1Database,
  context: CallContext,
  input: unknown,
  now = new Date().toISOString(),
) {
  const event = providerEventSchema.parse(input);
  return transact(binding, (state) => {
    const call = authorizeCall(state, context, false);
    const session = state.liveSessions.find((entry) => entry.id === call.id);
    requireCondition(
      session,
      "call_unavailable",
      "Live call unavailable.",
      404,
    );
    if (event.event_id && session.processedEventIds.includes(event.event_id))
      return false;
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      const fragment = transcriptEventSchema.parse(event);
      requireCondition(
        fragment.end_ms >= fragment.start_ms,
        "invalid_event",
        "Invalid transcript interval.",
      );
      if (fragment.delta) {
        state.transcriptFragments.push({
          sequence: state.transcriptFragments.filter(
            (entry) => entry.callId === call.id,
          ).length,
          id: `${call.id}:${fragment.event_id}`,
          callId: call.id,
          speaker:
            event.type === "session.input_transcript.delta"
              ? "carrier"
              : "broker",
          startMs: fragment.start_ms,
          endMs: fragment.end_ms,
          text: fragment.delta,
        });
        call.record.transcript.entries = state.transcriptFragments
          .filter((entry) => entry.callId === call.id)
          .sort(
            (a, b) =>
              a.startMs - b.startMs ||
              a.endMs - b.endMs ||
              a.sequence - b.sequence,
          )
          .map((entry) => ({
            id: entry.id,
            speaker: entry.speaker,
            offsetSeconds: Math.floor(entry.startMs / 1000),
            text: entry.text,
          }));
      }
      if (
        event.type === "session.input_transcript.delta" &&
        fragment.delta.trim()
      ) {
        session.lastInputAt = now;
        if (session.warned) session.notice = null;
        session.warned = false;
      }
    } else if (
      event.type === "session.usage.updated" ||
      event.type === "session.closed"
    ) {
      const usage = z
        .object({ seconds: z.number().nonnegative() })
        .parse(event.usage);
      chargeVoice(state, call.id, usage.seconds);
      if (event.type === "session.closed") {
        session.providerClosed = true;
        session.usageConfirmed = true;
      }
    } else if (event.type === "session.delegation.created") {
      const delegation = z
        .object({ target: z.string(), response_id: z.string().optional() })
        .parse(event.delegation);
      if (
        delegation.target === "responses" &&
        delegation.response_id &&
        !session.responseIds.includes(delegation.response_id)
      )
        session.responseIds.push(delegation.response_id);
    } else if (event.type === "response.event") {
      const nested = providerEventSchema.parse(event.event);
      if (
        [
          "response.created",
          "response.completed",
          "response.failed",
          "response.incomplete",
          "response.cancelled",
        ].includes(nested.type)
      ) {
        const response = responseEventSchema.parse(nested).response;
        if (!session.responseIds.includes(response.id))
          session.responseIds.push(response.id);
        if (nested.type !== "response.created") {
          requireCondition(
            response.usage,
            "accounting_unavailable",
            "Final delegated usage is missing.",
            503,
          );
          chargeUsage(
            state,
            call.id,
            `${call.id}:response:${response.id}`,
            resolvePeriod(
              response.created_at
                ? new Date(response.created_at * 1000).toISOString()
                : now,
            ),
            calculateResponseCostMicrodollars(
              response.usage.input_tokens,
              response.usage.input_tokens_details?.cached_tokens ?? 0,
              response.usage.output_tokens,
              state.reservations.find((entry) => entry.id === call.id)!.prices,
            ),
          );
          if (!session.completedResponseIds.includes(response.id))
            session.completedResponseIds.push(response.id);
        }
      }
    }
    if (event.event_id) session.processedEventIds.push(event.event_id);
    return true;
  });
}
