import type { Call } from "@voice-freight/contracts/calls";
import { callsSchema } from "@voice-freight/contracts/calls";
import { groupTranscript, type TranscriptFragment } from "@voice-freight/contracts/live";
import { summarizeCalls, type Dashboard } from "@voice-freight/contracts/reporting";
import { resolveCallAccess, resolveIdentity, selectCallAccess, type CallAccessRow } from "./authorization";
import { readState } from "./repository";
import type { CallContext } from "@voice-freight/contracts/business";
import type { Analysis, CallRecord } from "./model";
import type { Identity } from "@voice-freight/contracts/business";
import { requireCondition } from "./model";
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

type DashboardRow = { call: string; analysis: string | null };

const pendingDiscovery = `SELECT id FROM calls WHERE json_extract(data, '$.record.endedAt') IS NULL
  UNION SELECT id FROM analysis WHERE json_extract(data, '$.status') = 'pending'`;
const pendingCalls = `${pendingDiscovery}
  UNION SELECT calls.id FROM calls LEFT JOIN analysis ON analysis.id = calls.id
    WHERE analysis.id IS NULL AND COALESCE(json_extract(calls.data, '$.finalSnapshot.analysis.status'),
      json_extract(calls.data, '$.record.analysis.status')) = 'pending'`;

function selectDashboardVersion(
  binding: D1Database,
  filter: string,
  bindings: string[],
  ids?: string[],
): D1PreparedStatement {
  const selected = ids ? `SELECT value FROM json_each(?) UNION ${pendingDiscovery}` : pendingCalls;
  return binding
    .prepare(`WITH source AS (
    SELECT calls.id, COALESCE(json_extract(calls.data, '$.finalSnapshot'), json_extract(calls.data, '$.record')) AS record,
      analysis.data AS analysis
    FROM calls LEFT JOIN analysis ON analysis.id = calls.id WHERE ${filter} AND calls.id IN (${selected})
  )
  SELECT id, json_object(
    'startedAt', json_extract(record, '$.startedAt'), 'endedAt', json_extract(record, '$.endedAt'),
    'source', json_extract(record, '$.source'), 'carrier', json_extract(record, '$.carrier'),
    'eligibility', json_extract(record, '$.eligibility'), 'matched', json_extract(record, '$.matched'),
    'unresolvedError', json_extract(record, '$.unresolvedError'), 'outcomeReason', json_extract(record, '$.outcomeReason'),
    'loads', json_extract(record, '$.loads'), 'agreements', json_extract(record, '$.agreements'),
    'analysis', CASE WHEN analysis IS NULL THEN json_extract(record, '$.analysis')
      ELSE json_object('status', json_extract(analysis, '$.status'), 'result', json_extract(analysis, '$.result'),
        'reason', json_extract(analysis, '$.reason'), 'retryAt', json_extract(analysis, '$.nextAttemptAt')) END
  ) AS summary FROM source ORDER BY id`)
    .bind(...bindings, ...(ids ? [JSON.stringify(ids)] : []));
}

async function hashDashboardVersion(rows: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte): string => byte.toString(16).padStart(2, "0")).join("");
}

export async function queryDashboardVersion(
  binding: D1Database,
  userId: string,
  ids: string[],
): Promise<{ version: string }> {
  const identityData = await binding.prepare("SELECT data FROM users WHERE id = ?").bind(userId).first<string>("data");
  requireCondition(identityData, "unauthenticated", "Sign in to continue.", 401);
  const identity = JSON.parse(identityData) as Identity;
  const filter = identity.role === "administrator" ? "1" : "json_extract(calls.data, '$.ownerId') = ?";
  const bindings = identity.role === "administrator" ? [] : [userId];
  const [identityResult, versionResult] = await binding.batch([
    binding.prepare("SELECT data FROM users WHERE id = ?").bind(userId),
    selectDashboardVersion(binding, filter, bindings, ids),
  ]);
  requireCondition(
    (identityResult.results[0] as { data: string } | undefined)?.data === identityData,
    "unauthenticated",
    "Sign in to continue.",
    401,
  );
  return { version: await hashDashboardVersion(versionResult.results) };
}

function projectDashboardRow(row: DashboardRow): Call {
  const call = JSON.parse(row.call) as CallRecord;
  call.record.transcript.entries = [];

  if (call.finalSnapshot) {
    call.finalSnapshot.transcript.entries = [];
  }

  return projectCall(call, row.analysis ? (JSON.parse(row.analysis) as Analysis) : undefined);
}

export async function queryDashboardPage(
  binding: D1Database,
  userId: string,
  requestedPage: number,
  samples: { id: string; startedAt: string }[],
): Promise<Dashboard> {
  const identityData = await binding.prepare("SELECT data FROM users WHERE id = ?").bind(userId).first<string>("data");
  requireCondition(identityData, "unauthenticated", "Sign in to continue.", 401);
  const identity = JSON.parse(identityData) as Identity;
  const filter = identity.role === "administrator" ? "1" : "json_extract(calls.data, '$.ownerId') = ?";
  const bindings = identity.role === "administrator" ? [] : [userId];
  const projection = `json_remove(calls.data, '$.inventoryIds', '$.record.transcript.entries',
     '$.finalSnapshot.transcript.entries') AS call, analysis.data AS analysis`;
  const visible = `FROM calls LEFT JOIN analysis ON analysis.id = calls.id WHERE ${filter}`;
  const data = `WITH source AS (
      SELECT COALESCE(json_extract(calls.data, '$.finalSnapshot'), json_extract(calls.data, '$.record')) AS record,
        analysis.data AS analysis ${visible}
    ), facts AS (
      SELECT record, analysis,
        json_extract(record, '$.endedAt') AS ended,
        COALESCE(json_extract(analysis, '$.result.sentiment'),
          CASE WHEN analysis IS NULL THEN json_extract(record, '$.analysis.sentiment') ELSE 'Unknown' END) AS sentiment,
        (SELECT COUNT(*) FROM json_each(record, '$.agreements') WHERE json_extract(value, '$.status') = 'effective') AS agreementCount,
        (SELECT SUM(json_extract(a.value, '$.rateCents') - json_extract(l.value, '$.postedRateCents'))
          FROM json_each(record, '$.agreements') a JOIN json_each(record, '$.loads') l
            ON json_extract(a.value, '$.loadId') = json_extract(l.value, '$.id')
          WHERE json_extract(a.value, '$.status') = 'effective') AS variance
      FROM source
    )`;
  const [identityResult, summaryResult, pendingResult, pageResult, versionResult] = await binding.batch([
    binding.prepare("SELECT data FROM users WHERE id = ?").bind(userId),
    binding
      .prepare(`${data}
      SELECT COUNT(*) AS count,
        COUNT(ended) AS durations,
        SUM(CASE WHEN ended IS NOT NULL THEN ROUND(unixepoch(ended, 'subsec') - unixepoch(json_extract(record, '$.startedAt'), 'subsec'), 3) ELSE 0 END) AS durationSum,
        SUM(CASE WHEN ended IS NOT NULL AND (agreementCount > 0 OR (json_extract(record, '$.eligibility') = 'Eligible' AND json_extract(record, '$.matched') = 1 AND json_extract(record, '$.unresolvedError') = 0)) THEN 1 ELSE 0 END) AS matched,
        SUM(CASE WHEN ended IS NOT NULL AND agreementCount > 0 THEN 1 ELSE 0 END) AS agreementCalls,
        SUM(CASE WHEN ended IS NOT NULL THEN agreementCount ELSE 0 END) AS agreements,
        SUM(CASE WHEN ended IS NOT NULL THEN COALESCE(variance, 0) ELSE 0 END) AS varianceSum,
        SUM(CASE WHEN sentiment = 'Positive' THEN 1 ELSE 0 END) AS positive,
        SUM(CASE WHEN sentiment = 'Neutral' THEN 1 ELSE 0 END) AS neutral,
        SUM(CASE WHEN sentiment = 'Negative' THEN 1 ELSE 0 END) AS negative,
        SUM(CASE WHEN sentiment = 'Unknown' THEN 1 ELSE 0 END) AS unknown
      FROM facts`)
      .bind(...bindings),
    binding
      .prepare(`WITH source AS (
        SELECT calls.id, COALESCE(json_extract(calls.data, '$.finalSnapshot'), json_extract(calls.data, '$.record')) AS record,
          analysis.data AS analysis ${visible} AND calls.id IN (${pendingCalls})
      )
      SELECT id, json_extract(record, '$.endedAt') AS ended,
        COALESCE(json_extract(analysis, '$.status'), json_extract(record, '$.analysis.status')) AS status,
        CASE WHEN analysis IS NULL THEN json_extract(record, '$.analysis.reason') ELSE json_extract(analysis, '$.reason') END AS reason,
        CASE WHEN analysis IS NULL THEN json_extract(record, '$.analysis.retryAt') ELSE json_extract(analysis, '$.nextAttemptAt') END AS retryAt
      FROM source`)
      .bind(...bindings),
    binding
      .prepare(`WITH samples AS (
        SELECT CAST(key AS INTEGER) AS position, json_extract(value, '$.id') AS id,
          json_extract(value, '$.startedAt') AS startedAt FROM json_each(?)
      ), ranks AS (
        SELECT s.id, s.startedAt,
          (SELECT COUNT(*) FROM calls WHERE ${filter}
            AND json_extract(calls.data, '$.record.startedAt') > s.startedAt)
          + (SELECT COUNT(*) FROM samples other WHERE other.startedAt > s.startedAt
              OR (other.startedAt = s.startedAt AND other.position < s.position)) AS rank
        FROM samples s
      ), bounds AS (
        SELECT CASE WHEN ? > MAX(1, ((SELECT COUNT(*) FROM calls WHERE ${filter})
                                     + (SELECT COUNT(*) FROM samples) + 4) / 5)
          THEN 0 ELSE (? - 1) * 5 END AS offset
      ), selected AS (
        SELECT calls.id, 0 AS sample, ${projection} ${visible}
        ORDER BY json_extract(calls.data, '$.record.startedAt') DESC, calls.id ASC
        LIMIT 5 - (SELECT COUNT(*) FROM ranks, bounds WHERE ranks.rank >= bounds.offset AND ranks.rank < bounds.offset + 5)
        OFFSET (SELECT offset - (SELECT COUNT(*) FROM ranks WHERE ranks.rank < bounds.offset) FROM bounds)
      )
      SELECT id, sample, call, analysis FROM selected
      UNION ALL
      SELECT ranks.id, 1, NULL, NULL FROM ranks, bounds
      WHERE ranks.rank >= bounds.offset AND ranks.rank < bounds.offset + 5`)
      .bind(JSON.stringify(samples), ...bindings, requestedPage, ...bindings, requestedPage, ...bindings),
    selectDashboardVersion(binding, filter, bindings),
  ]);

  const currentIdentity = (identityResult.results[0] as { data: string } | undefined)?.data;
  requireCondition(currentIdentity === identityData, "unauthenticated", "Sign in to continue.", 401);
  type Summary = {
    count: number;
    durations: number;
    durationSum: number | null;
    matched: number | null;
    agreementCalls: number | null;
    agreements: number | null;
    varianceSum: number | null;
    positive: number | null;
    neutral: number | null;
    negative: number | null;
    unknown: number | null;
  };
  const summary = summaryResult.results[0] as Summary;
  const count = summary.count + samples.length;
  const page = requestedPage > Math.max(1, Math.ceil(count / 5)) ? 1 : requestedPage;
  const entries = pageResult.results as ({ id: string; sample: 0 | 1 } & DashboardRow)[];
  const matched = summary.matched ?? 0;
  const agreements = summary.agreements ?? 0;
  const agreementCalls = summary.agreementCalls ?? 0;
  const sentiments = (["Positive", "Neutral", "Negative", "Unknown"] as const).map((label) => {
    const number = summary[label.toLowerCase() as "positive" | "neutral" | "negative" | "unknown"] ?? 0;
    return { label, count: number, percentage: summary.count ? Math.round((number / summary.count) * 1000) / 10 : 0 };
  });
  const pending = pendingResult.results as {
    id: string;
    ended: string | null;
    status: "pending" | "complete" | "failed";
    reason: "queued" | "processing" | "retry" | "allowance" | null;
    retryAt: string | null;
  }[];

  return {
    calls: callsSchema.parse(entries.filter((entry): boolean => !entry.sample).map(projectDashboardRow)),
    sampleIds: entries.filter((entry): boolean => !!entry.sample).map((entry): string => entry.id),
    report: {
      callCount: summary.count,
      durationCount: summary.durations,
      averageDurationSeconds: summary.durations ? (summary.durationSum ?? 0) / summary.durations : null,
      matchedCallCount: matched,
      agreementCallCount: agreementCalls,
      agreementRate: matched ? agreementCalls / matched : null,
      finalAgreementCount: agreements,
      averageVarianceCents: agreements ? (summary.varianceSum ?? 0) / agreements : null,
      sentiments,
    },
    count,
    page,
    version: await hashDashboardVersion(versionResult.results),
    pending: pending.map((entry) => ({
      id: entry.id,
      endedAt: entry.ended,
      analysis: {
        status: entry.status,
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.retryAt ? { retryAt: entry.retryAt } : {}),
      },
    })),
  };
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
