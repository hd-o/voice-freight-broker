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
};

export type CallDetailLayoutProps = Omit<
  ApplicationLayoutProps,
  "activePage" | "children"
> & {
  record: CallDetail | null;
  loading?: boolean;
};

export function renderCallDetailLayout({
  record,
  loading = false,
  ...navigation
}: CallDetailLayoutProps) {
  return (
    <ApplicationLayout {...navigation} activePage="dashboard">
      {loading ? (
        <div
          role="status"
          aria-label="Loading call details"
          aria-busy="true"
          className="space-y-8"
        >
          <PageHeader title="Call details" subtitle="Loading the saved call" />
          <span className="sr-only">Loading call details</span>
          <div className="grid gap-8 xl:grid-cols-[392px_minmax(0,1fr)]">
            <Skeleton className="h-[720px]" />
            <Skeleton className="h-[720px]" />
          </div>
        </div>
      ) : record ? (
        <div className="space-y-8">
          <header className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-[30px] leading-9 font-semibold tracking-[-0.75px] [overflow-wrap:anywhere]">
                {record.carrier}
              </h1>
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
              <Transcript
                entries={record.transcript}
                emptyMessage="No transcript was recorded for this call."
                className="min-h-[550px] flex-1"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          <PageHeader
            title="Call details"
            subtitle="Inspect a saved conversation and its analysis"
          />
          <section
            aria-label="No call selected"
            className="rounded-[10px] border border-border bg-surface p-8 text-center"
          >
            <h2 className="text-xl font-semibold">No call selected</h2>
            <p className="mt-3 text-muted-foreground">
              Choose a call from the dashboard to see its details.
            </p>
            <Button
              className="mt-6"
              variant="outline"
              onClick={() => navigation.onNavigate("dashboard")}
            >
              Back to dashboard
            </Button>
          </section>
        </div>
      )}
    </ApplicationLayout>
  );
}
