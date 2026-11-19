import { transcriptEventSchema } from "@voice-freight/contracts/live";
import { z } from "zod";
import type { CallContext } from "@voice-freight/contracts/business";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { authorizeCall } from "./authorization";
import { requireCondition, type State } from "./model";
import { transact } from "./repository";
import * as tables from "./schema";
import {
  chargeUsage,
  chargeVoice,
  calculateResponseCostMicrodollars,
  resolvePeriod,
  settleCallSpending,
} from "./spending";

export const providerEventSchema = z.object({ type: z.string(), event_id: z.string().optional() }).passthrough();

export const responseEventSchema = z.object({
  type: z.string(),
  response: z
    .object({
      id: z.string(),
      created_at: z.number().optional(),
      usage: z
        .object({
          input_tokens: z.number(),
          output_tokens: z.number(),
          input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
        })
        .nullish(),
    })
    .passthrough(),
});

async function readProviderState(
  binding: D1Database,
  context: CallContext,
): Promise<{ version: number; state: State }> {
  const database = drizzle(binding);

  // The shared revision keeps these scoped writes compatible with all other
  // transactions, including the coordinator's stale-instance fence.
  const [revision, users, calls, sessions, reservations, periods, usage, fragments] = await database.batch([
    database.select().from(tables.revision),
    database.select().from(tables.users).where(eq(tables.users.id, context.userId)),
    database.select().from(tables.calls).where(eq(tables.calls.id, context.callId)),
    database.select().from(tables.liveSessions).where(eq(tables.liveSessions.id, context.callId)),
    database.select().from(tables.reservations).where(eq(tables.reservations.id, context.callId)),
    database.select().from(tables.spendingPeriods),
    database
      .select()
      .from(tables.providerUsage)
      .where(
        sql`${tables.providerUsage.id} >= ${`${context.callId}:`} AND ${tables.providerUsage.id} < ${`${context.callId};`}`,
      ),
    database
      .select()
      .from(tables.transcriptFragments)
      .where(sql`json_extract(${tables.transcriptFragments.data}, '$.callId') = ${context.callId}`),
  ]);

  return {
    version: revision[0].version,
    state: {
      users: users.map((row) => row.data),
      calls: calls.map((row) => row.data),
      liveSessions: sessions.map((row) => row.data),
      reservations: reservations.map((row) => row.data),
      spendingPeriods: periods.map((row) => row.data),
      providerUsage: usage.map((row) => row.data),
      transcriptFragments: fragments.map((row) => row.data),
      quotaResets: [],
      confirmationAttempts: [],
      sessions: [],
      inventory: [],
      negotiations: [],
      quotes: [],
      agreements: [],
      evidence: [],
      receipts: [],
      events: [],
      analysis: [],
    },
  };
}

export async function ingestProviderEvent(
  binding: D1Database,
  context: CallContext,
  input: unknown,
  now = new Date().toISOString(),
): Promise<boolean> {
  const event = providerEventSchema.parse(input);

  // Partial response deltas are not used by accounting or tool execution.
  // The completed output item and response lifecycle events remain authoritative.
  if (event.type === "response.event" && providerEventSchema.parse(event.event).type.endsWith(".delta")) {
    return false;
  }

  return transact(
    binding,
    (state): boolean => {
      const call = authorizeCall(state, context, false);
      const session = state.liveSessions.find((entry): boolean => entry.id === call.id);

      requireCondition(session, "call_unavailable", "Live call unavailable.", 404);

      if (event.event_id && session.processedEventIds.includes(event.event_id)) {
        return false;
      }

      if (event.type === "session.input_transcript.delta" || event.type === "session.output_transcript.delta") {
        const fragment = transcriptEventSchema.parse(event);

        if (fragment.delta) {
          state.transcriptFragments.push({
            sequence: state.transcriptFragments.filter((entry): boolean => entry.callId === call.id).length,
            id: `${call.id}:${fragment.event_id}`,
            callId: call.id,
            speaker: event.type === "session.input_transcript.delta" ? "carrier" : "broker",
            startMs: fragment.start_ms,
            endMs: fragment.end_ms,
            text: fragment.delta,
          });

          call.record.transcript.entries = state.transcriptFragments
            .filter((entry): boolean => entry.callId === call.id)
            .sort((a, b): number => a.startMs - b.startMs || a.endMs - b.endMs || a.sequence - b.sequence)
            .map((entry): (typeof call.record.transcript.entries)[number] => ({
              id: entry.id,
              speaker: entry.speaker,
              offsetSeconds: Math.floor(entry.startMs / 1000),
              text: entry.text,
            }));
        }

        if (event.type === "session.input_transcript.delta" && fragment.delta.trim()) {
          session.lastInputAt = now;

          if (session.warned) {
            session.notice = null;
          }

          session.warned = false;
        }
      } else if (event.type === "session.usage.updated" || event.type === "session.closed") {
        const usage = z.object({ seconds: z.number().nonnegative() }).parse(event.usage);

        if (!session.usageConfirmed) {
          chargeVoice(state, call.id, usage.seconds);
        }

        if (event.type === "session.closed" && !session.usageConfirmed) {
          session.providerClosed = true;
          session.usageConfirmed = true;

          if (
            event.reason === "connection_lost" &&
            !state.reservations.find((entry) => entry.id === call.id)?.settled
          ) {
            session.gap = true;
            session.accountingGap = true;
          }

          settleCallSpending(state, session);
        }
      } else if (event.type === "session.delegation.created") {
        const delegation = z.object({ target: z.string(), response_id: z.string().optional() }).parse(event.delegation);

        if (
          delegation.target === "responses" &&
          delegation.response_id &&
          !session.responseIds.includes(delegation.response_id)
        ) {
          session.responseIds.push(delegation.response_id);
        }
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

          if (!session.responseIds.includes(response.id)) {
            session.responseIds.push(response.id);
          }

          if (nested.type !== "response.created" && response.usage) {
            const usageId = `${call.id}:response:${response.id}`;
            const savedUsage = state.providerUsage.find((entry): boolean => entry.id === usageId);

            chargeUsage(
              state,
              call.id,
              usageId,
              response.created_at
                ? resolvePeriod(new Date(response.created_at * 1000).toISOString())
                : (savedUsage?.periodId ?? resolvePeriod(now)),
              calculateResponseCostMicrodollars(
                response.usage.input_tokens,
                response.usage.input_tokens_details?.cached_tokens ?? 0,
                response.usage.output_tokens,
                state.reservations.find((entry): boolean => entry.id === call.id)!.prices,
              ),
            );

            if (!session.completedResponseIds.includes(response.id)) {
              session.completedResponseIds.push(response.id);
            }

            if (session.providerClosed) {
              settleCallSpending(state, session);
            }
          }
        }
      }

      if (event.event_id) {
        session.processedEventIds.push(event.event_id);
      }

      return true;
    },
    (database) => readProviderState(database, context),
  );
}
