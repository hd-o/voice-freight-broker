import {
  renderApplicationLayout as ApplicationLayout,
  type ApplicationLayoutProps,
} from "./application-layout";
import { renderPageHeader as PageHeader } from "@/components/navigation/page-header";
import { renderBadge as Badge } from "@/components/ui/badge";
import { renderButton as Button } from "@/components/ui/button";
import { renderSkeleton as Skeleton } from "@/components/ui/skeleton";
import {
  renderLoadSummary as LoadSummary,
  type LoadSummaryProps,
} from "@/components/dashboard/load-summary";
import {
  renderAnalysisSummary as AnalysisSummary,
  type AnalysisSummaryProps,
} from "@/components/dashboard/analysis-summary";
import {
  renderTranscript as Transcript,
  type TranscriptEntry,
} from "@/components/call/transcript";

export type CallDetail = {
  carrier: string;
  source: "Sample" | "Live";
  dateAndDuration: string;
  loadSummary: LoadSummaryProps;
  analysis: AnalysisSummaryProps;
  transcript: readonly TranscriptEntry[];
  transcriptComplete?: boolean;
};

export type CallDetailLayoutProps = Omit<
  ApplicationLayoutProps,
  "activePage" | "children"
> & {
  record: CallDetail | null;
  loading?: boolean;
  unavailable?: boolean;
  notice?: string;
};

export function renderCallDetailLayout({
  record,
  loading = false,
  unavailable = false,
  notice,
  ...navigation
}: CallDetailLayoutProps) {
  return (
    <ApplicationLayout {...navigation} activePage="dashboard">
      <div className="space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageHeader
            title="Call details"
            subtitle="Inspect a saved conversation and its analysis"
          />
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => navigation.onNavigate("dashboard")}
          >
            Back to dashboard
          </Button>
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
              <>
                <header className="min-w-0">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-semibold [overflow-wrap:anywhere]">
                      {record.carrier}
                    </h2>
                    <Badge>{record.source} Call</Badge>
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {record.dateAndDuration}
                  </p>
                </header>
                <div className="grid items-stretch gap-8 xl:grid-cols-[392px_minmax(0,1fr)]">
                  <LoadSummary {...record.loadSummary} />
                  <div className="flex min-w-0 flex-col gap-4 rounded-[10px] border border-border bg-surface p-6">
                    <AnalysisSummary {...record.analysis} />
                    {record.transcriptComplete === false && (
                      <p className="text-sm text-muted-foreground">
                        Partial transcript · The connection ended before the
                        conversation was complete.
                      </p>
                    )}
                    <Transcript
                      entries={record.transcript}
                      emptyMessage="No transcript was recorded for this call."
                      className="min-h-[300px] flex-1"
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-[10px] border border-border bg-surface p-8 text-center">
                <h2 className="text-xl font-semibold">
                  {unavailable ? "Call unavailable" : "No call selected"}
                </h2>
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
