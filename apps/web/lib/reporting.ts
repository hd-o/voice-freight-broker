import type { Call, Load } from "@voice-freight/contracts/calls";
import { describeOutcome, listFinalAgreements, summarizeCalls } from "@voice-freight/contracts/reporting";
import type { CallRecord } from "@/components/dashboard/call-history";
import type { CallDetail } from "@/components/layouts/call-detail-layout";
import type { LoadDetails } from "@/components/dashboard/load-summary";

export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

export function formatDuration(seconds: number): string {
  const duration = Math.round(seconds);

  return `${Math.floor(duration / 60)}m ${String(duration % 60).padStart(2, "0")}s`;
}

export function formatDate(timestamp: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(timestamp));
}

export function createHistory(calls: readonly Call[]): CallRecord[] {
  return calls.map((call): CallRecord => {
    const agreements = listFinalAgreements(call);

    return {
      id: call.id,
      date: formatDate(call.startedAt),
      source: call.source,
      carrier: call.carrier?.name ?? "Unknown carrier",
      load:
        call.loads.map((load): string => `${load.reference}: ${load.origin} → ${load.destination}`).join("; ") ||
        "No load selected",
      outcome: describeOutcome(call),
      agreements: String(agreements.length),
      rate: agreements.map((agreement): string => formatMoney(agreement.rateCents)).join(" / ") || "No final rate",
      sentiment: call.analysis.sentiment,
      analysis: ({ complete: "Complete", pending: "Pending", failed: "Failed" } as const)[call.analysis.status],
    };
  });
}

export function mergeReports(
  first: ReturnType<typeof summarizeCalls>,
  second: ReturnType<typeof summarizeCalls>,
): ReturnType<typeof summarizeCalls> {
  const callCount = first.callCount + second.callCount;
  const durationCount = first.durationCount + second.durationCount;
  const matchedCallCount = first.matchedCallCount + second.matchedCallCount;
  const agreementCallCount = first.agreementCallCount + second.agreementCallCount;
  const finalAgreementCount = first.finalAgreementCount + second.finalAgreementCount;

  return {
    callCount,
    durationCount,
    averageDurationSeconds: durationCount
      ? ((first.averageDurationSeconds ?? 0) * first.durationCount +
          (second.averageDurationSeconds ?? 0) * second.durationCount) /
        durationCount
      : null,
    matchedCallCount,
    agreementCallCount,
    agreementRate: matchedCallCount ? agreementCallCount / matchedCallCount : null,
    finalAgreementCount,
    averageVarianceCents: finalAgreementCount
      ? ((first.averageVarianceCents ?? 0) * first.finalAgreementCount +
          (second.averageVarianceCents ?? 0) * second.finalAgreementCount) /
        finalAgreementCount
      : null,
    sentiments: first.sentiments.map((entry, index) => {
      const count = entry.count + second.sentiments[index].count;
      return { label: entry.label, count, percentage: callCount ? Math.round((count / callCount) * 1000) / 10 : 0 };
    }),
  };
}

export function createMetrics(calls: readonly Call[]): { label: string; value: string; description: string }[] {
  return createReportMetrics(summarizeCalls(calls));
}

export function createReportMetrics(
  report: ReturnType<typeof summarizeCalls>,
): { label: string; value: string; description: string }[] {
  return [
    {
      label: "Calls",
      value: String(report.callCount),
      description: `${report.callCount} calls in this population`,
    },
    {
      label: "Avg. duration",
      value: report.averageDurationSeconds === null ? "Unavailable" : formatDuration(report.averageDurationSeconds),
      description: `${report.durationCount} ended calls`,
    },
    {
      label: "Agreement rate",
      value: report.agreementRate === null ? "Unavailable" : `${Math.round(report.agreementRate * 100)}%`,
      description: `${report.agreementCallCount} of ${report.matchedCallCount} matched calls`,
    },
    {
      label: "Final agreements",
      value: String(report.finalAgreementCount),
      description: "Effective at call end",
    },
    {
      label: "Avg. rate variance",
      value:
        report.averageVarianceCents === null
          ? "Unavailable"
          : `${report.averageVarianceCents > 0 ? "+" : ""}${formatMoney(report.averageVarianceCents)}`,
      description: `${report.finalAgreementCount} final agreements · Not margin`,
    },
  ];
}

export function createLoadDetails(call: Call, load: Load): LoadDetails {
  const agreement = listFinalAgreements(call).find((agreement): boolean => agreement.loadId === load.id);
  const variance = agreement ? agreement.rateCents - load.postedRateCents : null;

  const agreementLabels = {
    effective: "Accepted",
    cancelled: "Cancelled",
    superseded: "Replaced",
  } as const;

  return {
    route: `${load.origin} → ${load.destination}`,
    rate: agreement ? formatMoney(agreement.rateCents) : "No agreement",
    comparison:
      variance === null
        ? "No final rate accepted"
        : variance === 0
          ? "At posted rate"
          : `${formatMoney(Math.abs(variance))} ${variance > 0 ? "above" : "below"} posted rate`,
    snapshot: [
      `${load.reference} · ${load.equipment} · ${load.miles.toLocaleString("en-US")} miles`,
      load.pickupTimeZone ? `Pickup ${formatDate(load.pickupAt, load.pickupTimeZone)}` : "Pickup time zone unavailable",
      `Delivery ${formatDate(load.deliveryAt)}`,
      `${load.commodity} · ${load.weightPounds.toLocaleString("en-US")} lb`,
    ],
    negotiation: [
      { label: "Posted quote", value: formatMoney(load.postedRateCents) },
      ...load.negotiation.map((entry, index): { label: string; value: string } => ({
        label: `${entry.kind} ${index + 1}`,
        value: formatMoney(entry.rateCents),
      })),
      ...call.agreements
        .filter((entry): boolean => entry.loadId === load.id)
        .map((entry, index): { label: string; value: string } => ({
          label: `${agreementLabels[entry.status]} agreement ${index + 1}`,
          value: formatMoney(entry.rateCents),
        })),
      {
        label: "Final rate",
        value: agreement ? formatMoney(agreement.rateCents) : "No agreement",
        emphasized: true,
      },
    ],
  };
}

export function createCallDetail(
  call: Call,
  loadId: string | null,
  onLoadChange: (value: string | null) => void,
): CallDetail {
  const load = loadId === null ? call.loads[0] : call.loads.find((load): boolean => load.id === loadId);

  const duration =
    call.endedAt === null
      ? "Duration unavailable"
      : formatDuration((Date.parse(call.endedAt) - Date.parse(call.startedAt)) / 1000);

  return {
    loadSummary: {
      source: call.source,
      dateAndDuration: `${formatDate(call.startedAt)} · ${duration}`,
      outcome: describeOutcome(call),
      eligibility: `Carrier ${call.eligibility.toLowerCase()}`,
      carrier: call.carrier?.name ?? "Unknown carrier",
      mcNumber: call.carrier?.mcNumber ?? "Unknown",
      selector: {
        options: call.loads.map((load): { value: string; label: string } => ({
          value: load.id,
          label: load.reference,
        })),
        value: load?.id ?? null,
        countLabel: load ? `${call.loads.indexOf(load) + 1} of ${call.loads.length}` : `0 of ${call.loads.length}`,
        disabled: call.loads.length === 0,
        onValueChange: onLoadChange,
      },
      load: load ? createLoadDetails(call, load) : null,
    },
    analysis: {
      ...call.analysis,
      summary: call.analysis.summary ?? undefined,
      connection: call.connection,
    },
    transcriptComplete: call.transcript.complete,
    transcript: call.transcript.entries.map((entry): CallDetail["transcript"][number] => ({
      ...entry,
      label: entry.speaker === "carrier" ? "Carrier" : "Northstar",
      time: `${String(Math.floor(entry.offsetSeconds / 60)).padStart(2, "0")}:${String(entry.offsetSeconds % 60).padStart(2, "0")}`,
    })),
  };
}
