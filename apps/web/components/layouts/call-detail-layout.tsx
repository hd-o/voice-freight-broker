import Link from "next/link";
import { ApplicationLayout, type ApplicationLayoutProps } from "./application-layout";
import { PageHeader } from "@/components/navigation/page-header";
import { Button, getButtonClasses } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadSummary, type LoadSummaryProps } from "@/components/dashboard/load-summary";
import { AnalysisSummary, type AnalysisSummaryProps } from "@/components/dashboard/analysis-summary";
import { Transcript, type TranscriptEntry } from "@/components/call/transcript";

export type CallDetail = {
  loadSummary: LoadSummaryProps;
  analysis: AnalysisSummaryProps;
  transcript: readonly TranscriptEntry[];
  transcriptComplete?: boolean;
};

export type CallDetailLayoutProps = Omit<ApplicationLayoutProps, "activePage" | "children"> & {
  record: CallDetail | null;
  loading?: boolean;
  unavailable?: boolean;
  notice?: string;
  dashboardHref?: string;
};

export function CallDetailLayout({
  record,
  loading = false,
  unavailable = false,
  notice,
  dashboardHref = "/dashboard",
  ...navigation
}: CallDetailLayoutProps): React.JSX.Element {
  return (
    <ApplicationLayout {...navigation} activePage="dashboard">
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageHeader title="Call details" subtitle="Inspect a saved conversation and its analysis" />
          {loading ? (
            <Button variant="outline" disabled>
              Back to dashboard
            </Button>
          ) : (
            <Link href={dashboardHref} className={getButtonClasses({ variant: "outline" })}>
              Back to dashboard
            </Link>
          )}
        </div>
        {notice && <p role="status">{notice}</p>}
        {loading ? (
          <div
            role="status"
            aria-label="Loading call details"
            aria-busy="true"
            className="grid gap-8 xl:grid-cols-[392px_minmax(0,1fr)]"
          >
            <span className="sr-only">Loading call details</span>
            <Skeleton className="h-[720px]" />
            <Skeleton className="h-[720px]" />
          </div>
        ) : (
          <section aria-label="Call details" className="space-y-6">
            {record ? (
              <div className="grid items-stretch gap-8 xl:grid-cols-[392px_minmax(0,1fr)]">
                <LoadSummary {...record.loadSummary} />
                <div className="flex min-w-0 flex-col gap-4 rounded-[10px] border border-border bg-surface p-6">
                  <AnalysisSummary {...record.analysis} />
                  {record.transcriptComplete === false && (
                    <p className="text-sm text-muted-foreground">
                      Partial transcript · The connection ended before the conversation was complete.
                    </p>
                  )}
                  <Transcript
                    entries={record.transcript}
                    emptyMessage="No transcript was recorded for this call."
                    className="min-h-[300px] flex-1"
                  />
                </div>
              </div>
            ) : (
              <div className="rounded-[10px] border border-border bg-surface p-8 text-center">
                <h2 className="text-xl font-semibold">{unavailable ? "Call unavailable" : "No call selected"}</h2>
                <p className="mt-3 text-muted-foreground">
                  {unavailable
                    ? "This call is unavailable to this account. Return to the dashboard and choose an available call."
                    : "Choose a call from the dashboard to see its details."}
                </p>
              </div>
            )}
          </section>
        )}
      </div>
    </ApplicationLayout>
  );
}
