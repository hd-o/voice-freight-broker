import { z } from "zod";
import type { Call } from "@voice-freight/contracts/calls";
import type { CallContext } from "@voice-freight/contracts/business";
import { authorizeCall, resolveIdentity } from "./authorization";
import { requireCondition } from "./model";
import type { Analysis, AnalysisAttempt, State } from "./model";
import { readState, transact } from "./repository";
import { collectTranscript } from "./live";
import { describeOutcome } from "@voice-freight/contracts/reporting";
import { describeLoad } from "./readbacks";
import {
  calculateAvailableMicrodollars,
  calculateResponseCostMicrodollars,
  chargeUsage,
  modelPrices,
  resolvePeriod,
} from "./spending";

export const analysisJobSchema = z.strictObject({ callId: z.string().uuid(), version: z.number().int().positive() });
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export const maximumAnalysisAttempts = 3;
export const analysisPromptVersion = "call-analysis-v4";
export const analysisModel = "gpt-6-luna";
export const maximumAnalysisOutputTokens = 2048;
// Include the constrained evidence-ID schema as well as the transcript and
// instructions. One UTF-8 byte per token conservatively bounds the full body.
export const maximumAnalysisInputBytes = 100_000;
export const analysisReservationMicrodollars = calculateResponseCostMicrodollars(
  maximumAnalysisInputBytes,
  0,
  maximumAnalysisOutputTokens,
);

export const analysisOutputSchema = z.strictObject({
  summary: z.string().min(1).max(2400),
  sentiment: z.enum(["Positive", "Neutral", "Negative", "Unknown"]),
  evidenceIds: z.array(z.string()).max(12),
});

export type AnalysisInput = {
  call: Pick<Call, "carrier" | "eligibility" | "connection" | "agreements"> & {
    outcome: ReturnType<typeof describeOutcome>;
    loads: (Call["loads"][number] & { spokenLabel: string })[];
  };
  transcript: { complete: boolean; entries: Call["transcript"]["entries"] };
};

export type AnalysisResponse =
  | { status: "not_started" }
  | {
      id: string;
      createdAt: string;
      usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number } | null;
      output: unknown;
    };

export type AnalysisProvider = (input: AnalysisInput, attemptId: string) => Promise<AnalysisResponse>;

function resolveJob(state: State, job: AnalysisJob): Analysis | undefined {
  return state.analysis.find((entry): boolean => entry.callId === job.callId && entry.version === job.version);
}

function resolveDeadline(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1000).toISOString();
}

function failAttempt(analysis: Analysis, attempt: AnalysisAttempt, now: string): void {
  attempt.finishedAt = now;
  analysis.reason = "retry";
  analysis.error = attempt.usageConfirmed ? "invalid_output" : "usage_uncertain";
  analysis.nextAttemptAt = resolveDeadline(now, 15 * 2 ** ((analysis.runAttempts ?? 1) - 1));
  analysis.publication = "pending";

  if ((analysis.runAttempts ?? 0) >= maximumAnalysisAttempts) {
    analysis.status = "failed";
    analysis.publication = "dead-letter";
    delete analysis.reason;
    delete analysis.nextAttemptAt;
  }
}

function recoverAttempt(analysis: Analysis, now: string): void {
  const attempt = analysis.history?.at(-1);

  if (attempt && !attempt.finishedAt && Date.parse(attempt.leaseUntil) <= Date.parse(now)) {
    // No proof of provider usage survives this crash window. Keep its money
    // reserved; a new paid attempt gets a different reservation.
    failAttempt(analysis, attempt, now);
  }
}

function collectInput(state: State, callId: string): AnalysisInput {
  const record = state.calls.find((entry): boolean => entry.id === callId)!;
  const snapshot = record.finalSnapshot!;
  const live = state.liveSessions.some((entry): boolean => entry.id === callId);
  const entries = live
    ? collectTranscript(state, callId).map((entry): Call["transcript"]["entries"][number] => ({
        id: entry.id,
        speaker: entry.speaker,
        offsetSeconds: Math.floor(entry.startMs / 1000),
        text: entry.text,
      }))
    : record.record.transcript.entries;

  const input: AnalysisInput = {
    call: {
      carrier: snapshot.carrier,
      eligibility: snapshot.eligibility,
      connection: snapshot.connection,
      outcome: describeOutcome(snapshot),
      loads: snapshot.loads.map((load): AnalysisInput["call"]["loads"][number] => describeLoad(state, callId, load)),
      agreements: snapshot.agreements,
    },
    transcript: { complete: record.record.transcript.complete, entries: [] },
  };

  const encoder = new TextEncoder();

  for (const entry of entries) {
    input.transcript.entries.push(entry);

    if (encoder.encode(JSON.stringify(input)).byteLength > 54_000) {
      input.transcript.entries.pop();
      input.transcript.complete = false;
      break;
    }
  }

  requireCondition(
    encoder.encode(JSON.stringify(input)).byteLength <= 54_000,
    "analysis_input_limit",
    "Analysis input exceeds its reserved allowance.",
    503,
  );
  return input;
}

export async function processAnalysis(
  binding: D1Database,
  input: unknown,
  provider: AnalysisProvider,
  now = new Date().toISOString(),
): Promise<"ack" | "retry" | "dead-letter"> {
  const job = analysisJobSchema.parse(input);
  const claim = await transact(binding, (state): { attempt: AnalysisAttempt; input: AnalysisInput } | null => {
    const analysis = resolveJob(state, job);

    if (!analysis || analysis.status !== "pending") {
      return null;
    }

    recoverAttempt(analysis, now);

    if (analysis.status !== "pending" || (analysis.nextAttemptAt && analysis.nextAttemptAt > now)) {
      return null;
    }

    const active = analysis.history?.at(-1);

    if (active && !active.finishedAt) {
      return null;
    }

    const call = state.calls.find((entry): boolean => entry.id === job.callId);
    const session = state.liveSessions.find((entry): boolean => entry.id === job.callId);

    if (!call?.finalSnapshot || (session && session.state !== "ended")) {
      return null;
    }

    const source = collectInput(state, call.id);

    if (calculateAvailableMicrodollars(state, now) < analysisReservationMicrodollars) {
      analysis.reason = "allowance";
      analysis.publication = "pending";
      analysis.nextAttemptAt = new Date(Date.UTC(Number(now.slice(0, 4)), Number(now.slice(5, 7)), 1)).toISOString();
      return null;
    }

    analysis.attempts++;
    analysis.runAttempts = (analysis.runAttempts ?? 0) + 1;
    analysis.reason = "processing";
    analysis.model = analysisModel;
    analysis.promptVersion = analysisPromptVersion;
    delete analysis.nextAttemptAt;
    const id = `${analysis.id}:v${analysis.version}:a${analysis.attempts}`;
    const attempt: AnalysisAttempt = {
      id,
      version: analysis.version,
      startedAt: now,
      leaseUntil: resolveDeadline(now, 90),
      usageConfirmed: false,
    };
    (analysis.history ??= []).push(attempt);
    state.reservations.push({
      id,
      kind: "analysis",
      ownerId: call.ownerId,
      operationId: id,
      createdAt: now,
      reservedMicrodollars: analysisReservationMicrodollars,
      chargedMicrodollars: 0,
      settled: false,
      prices: { ...modelPrices },
    });
    return { attempt, input: source };
  });

  if (!claim) {
    return queryDisposition(binding, job);
  }

  try {
    const response = await provider(claim.input, claim.attempt.id);
    await transact(binding, (state): void => {
      const analysis = state.analysis.find((entry): boolean => entry.callId === job.callId);
      const attempt = analysis?.history?.find((entry): boolean => entry.id === claim.attempt.id);
      requireCondition(analysis && attempt, "analysis_unavailable", "Analysis attempt unavailable.", 503);
      const reservation = state.reservations.find((entry): boolean => entry.id === attempt.id)!;

      if ("status" in response) {
        // A trusted adapter can prove preflight failed before any paid request.
        reservation.settled = true;
        attempt.usageConfirmed = true;

        if (attempt.finishedAt || analysis.status !== "pending" || analysis.version !== job.version) {
          return;
        }

        failAttempt(analysis, attempt, now);
        analysis.error = "provider_unavailable";
        return;
      }

      if (response.usage) {
        chargeUsage(
          state,
          attempt.id,
          `analysis-response:${response.id}`,
          resolvePeriod(response.createdAt),
          calculateResponseCostMicrodollars(
            response.usage.inputTokens,
            response.usage.cachedInputTokens,
            response.usage.outputTokens,
            reservation.prices,
          ),
        );
        attempt.responseId = response.id;
        attempt.usageConfirmed = true;
        reservation.settled = true;
      }

      if (attempt.finishedAt || analysis.status !== "pending" || analysis.version !== job.version) {
        return;
      }

      const output = analysisOutputSchema.safeParse(response.output);
      const entries = claim.input.transcript.entries;
      const evidenceIds = new Set(entries.map((entry): string => entry.id));

      if (
        !attempt.usageConfirmed ||
        !output.success ||
        !output.data.evidenceIds.every((id): boolean => evidenceIds.has(id))
      ) {
        failAttempt(analysis, attempt, now);
        return;
      }

      const callerEvidence = entries.some(
        (entry): boolean => entry.speaker === "carrier" && entry.text.trim().length > 3,
      );
      const citedCaller = entries.some(
        (entry): boolean => entry.speaker === "carrier" && output.data.evidenceIds.includes(entry.id),
      );
      analysis.result = {
        status: "complete",
        summary: entries.length
          ? output.data.summary
          : "No transcript was recorded. Agreement facts remain available in the call details.",
        sentiment: callerEvidence && citedCaller ? output.data.sentiment : "Unknown",
      };
      analysis.evidenceIds = output.data.evidenceIds;
      analysis.status = "complete";
      analysis.publication = "published";
      attempt.finishedAt = now;
      delete analysis.reason;
      delete analysis.error;
    });
  } catch {
    // Provider text and exceptions may contain transcripts, credentials or PII.
    // Persist an allowlisted code only; uncertain usage stays reserved.
    await transact(binding, (state): void => {
      const analysis = resolveJob(state, job);
      const attempt = analysis?.history?.find((entry): boolean => entry.id === claim.attempt.id);

      if (analysis?.status === "pending" && attempt && !attempt.finishedAt) {
        failAttempt(analysis, attempt, now);
      }
    });
  }

  return queryDisposition(binding, job);
}

async function queryDisposition(binding: D1Database, job: AnalysisJob): Promise<"ack" | "retry" | "dead-letter"> {
  const { state } = await readState(binding);
  const analysis = resolveJob(state, job);

  if (analysis?.status === "failed") {
    return "dead-letter";
  }

  return analysis?.status === "pending" && analysis.reason !== "allowance" ? "retry" : "ack";
}

export async function publishAnalysis(
  binding: D1Database,
  queue: { send(job: AnalysisJob): Promise<unknown> },
  now = new Date().toISOString(),
): Promise<void> {
  const jobs = await transact(binding, (state): AnalysisJob[] => {
    const jobs: AnalysisJob[] = [];

    for (const analysis of state.analysis) {
      recoverAttempt(analysis, now);
      const session = state.liveSessions.find((entry): boolean => entry.id === analysis.callId);
      const active = analysis.history?.at(-1);

      if (
        analysis.status !== "pending" ||
        (session && session.state !== "ended") ||
        (active && !active.finishedAt) ||
        (analysis.nextAttemptAt && analysis.nextAttemptAt > now)
      ) {
        continue;
      }

      if (
        analysis.publication === "published" &&
        analysis.publishedAt &&
        Date.parse(now) - Date.parse(analysis.publishedAt) < 120_000
      ) {
        continue;
      }

      // Lease publication. A crash before send is repaired after this deadline;
      // a crash after send can redeliver, but cannot claim a second paid attempt.
      analysis.publication = "published";
      analysis.publishedAt = now;
      jobs.push({ callId: analysis.callId, version: analysis.version });

      if (jobs.length === 20) {
        break;
      }
    }

    return jobs;
  });

  for (const job of jobs) {
    await queue.send(job);
  }
}

export async function recordDeadLetter(binding: D1Database, input: unknown): Promise<void> {
  const job = analysisJobSchema.parse(input);
  await transact(binding, (state): void => {
    const analysis = resolveJob(state, job);

    if (!analysis || analysis.status !== "pending" || analysis.reason === "allowance") {
      return;
    }

    const active = analysis.history?.at(-1);

    if (active && !active.finishedAt) {
      return;
    }

    analysis.status = "failed";
    analysis.publication = "dead-letter";
    analysis.error = "retries_exhausted";
    delete analysis.reason;
    delete analysis.nextAttemptAt;
  });
}

export async function retryAnalysis(binding: D1Database, context: CallContext, version: number): Promise<AnalysisJob> {
  return transact(binding, (state): AnalysisJob => {
    requireCondition(
      resolveIdentity(state, context.userId).role === "administrator",
      "forbidden",
      "Administrator access required.",
      403,
    );
    authorizeCall(state, context, false);
    const analysis = state.analysis.find((entry): boolean => entry.callId === context.callId);
    requireCondition(analysis, "analysis_unavailable", "Analysis unavailable.", 404);

    if (analysis.version > version && analysis.status === "pending") {
      return { callId: context.callId, version: analysis.version };
    }

    requireCondition(
      analysis.status === "failed" && analysis.version === version,
      "analysis_changed",
      "Only the current failed analysis can be retried.",
    );
    analysis.version++;
    analysis.status = "pending";
    analysis.publication = "pending";
    analysis.runAttempts = 0;
    analysis.reason = "queued";
    delete analysis.result;
    delete analysis.error;
    delete analysis.nextAttemptAt;
    delete analysis.publishedAt;
    return { callId: context.callId, version: analysis.version };
  });
}
