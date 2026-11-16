"use client";

import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

const analysisLabels = {
  complete: "Complete",
  pending: "Pending",
  failed: "Failed",
} as const;

export type AnalysisSummaryProps = {
  sentiment: string;
  connection: string;
  status: keyof typeof analysisLabels;
  summary?: string;
  administrator?: boolean;
  retrying?: boolean;
  error?: string;
  reason?: "queued" | "processing" | "retry" | "allowance";
  retryAt?: string;
  onRetry?: () => void;
};

export function AnalysisSummary({
  sentiment,
  connection,
  status,
  summary,
  administrator = false,
  retrying = false,
  error,
  reason,
  retryAt,
  onRetry,
}: AnalysisSummaryProps): React.JSX.Element {
  return (
    <section aria-label="Call analysis" className="min-w-0 space-y-4">
      <dl className="grid gap-3 sm:grid-cols-3">
        {[
          { label: "Connection", value: connection },
          { label: "Analysis", value: analysisLabels[status] },
          { label: "Sentiment", value: sentiment },
        ].map((item): React.JSX.Element => (
          <div key={item.label} className="min-w-0 space-y-1 rounded-lg bg-muted p-3">
            <dt className="text-xs leading-4 text-muted-foreground">{item.label}</dt>
            <dd className="break-words font-semibold">{item.value}</dd>
          </div>
        ))}
      </dl>
      {status === "complete" ? (
        <p className="[overflow-wrap:anywhere]">{summary || "No summary is available for this call."}</p>
      ) : (
        <div role="status" className="rounded-lg bg-muted p-4">
          <p className="flex items-center gap-2 font-medium">
            {status === "pending" ? (
              <>
                <LoaderCircle aria-hidden="true" size={16} className="animate-spin" />
                Analyzing call
              </>
            ) : (
              "Analysis failed"
            )}
          </p>
          <p className="mt-2 text-muted-foreground">
            {status === "pending"
              ? reason === "allowance"
                ? `Analysis is waiting for the shared monthly allowance. It will resume ${retryAt ? `after ${new Date(retryAt).toUTCString()}` : "after renewal at 00:00 UTC on the first day"}.`
                : reason === "retry"
                  ? "Analysis was interrupted and will retry automatically. The saved call is preserved."
                  : "Summary and sentiment analysis will appear when complete."
              : "The call transcript is saved. An administrator can retry the analysis."}
          </p>
          {error && (
            <p role="alert" className="mt-2">
              {error}
            </p>
          )}
          {status === "failed" && administrator ? (
            <Button className="mt-3" variant="outline" disabled={!onRetry || retrying} onClick={onRetry}>
              {retrying ? "Retrying analysis…" : "Retry analysis"}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}
