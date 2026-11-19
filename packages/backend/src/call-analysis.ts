import { callSchema } from "@voice-freight/contracts/calls";
import type { Call } from "@voice-freight/contracts/calls";
import type { CallContext, Identity } from "@voice-freight/contracts/business";
import type { Analysis } from "./model";
import { requireCondition } from "./model";

export async function queryCallAnalysis(binding: D1Database, context: CallContext): Promise<Call["analysis"]> {
  const row = await binding
    .prepare(`SELECT users.data AS identity, calls.id AS callId,
      json_extract(calls.data, '$.ownerId') AS ownerId,
      COALESCE(json_extract(calls.data, '$.finalSnapshot.analysis'), json_extract(calls.data, '$.record.analysis')) AS fallback,
      analysis.data AS analysis
    FROM users LEFT JOIN calls ON calls.id = ?
    LEFT JOIN analysis ON analysis.id = calls.id WHERE users.id = ?`)
    .bind(context.callId, context.userId)
    .first<{
      identity: string;
      callId: string | null;
      ownerId: string | null;
      fallback: string | null;
      analysis: string | null;
    }>();

  requireCondition(row, "unauthenticated", "Sign in to continue.", 401);
  const user = JSON.parse(row.identity) as Identity;
  requireCondition(
    row.callId && (row.ownerId === user.id || user.role === "administrator"),
    "call_unavailable",
    "Call unavailable.",
    404,
  );
  const analysis = row.analysis ? (JSON.parse(row.analysis) as Analysis) : undefined;
  return callSchema.shape.analysis.parse(
    analysis?.result
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
        : JSON.parse(row.fallback!),
  );
}
