import {
  renderApplicationLayout as ApplicationLayout,
  type ApplicationLayoutProps,
} from "./application-layout";
import { renderPageHeader as PageHeader } from "@/components/navigation/page-header";
import {
  renderMetricCard as MetricCard,
  type MetricCardProps,
} from "@/components/dashboard/metric-card";
import {
  renderSentimentDistribution as SentimentDistribution,
  type SentimentDistributionProps,
} from "@/components/dashboard/sentiment-distribution";
import {
  renderCallHistory as CallHistory,
  type CallHistoryProps,
} from "@/components/dashboard/call-history";
import { renderSkeleton as Skeleton } from "@/components/ui/skeleton";

export type DashboardLayoutProps = Omit<
  ApplicationLayoutProps,
  "activePage" | "children"
> & {
  metrics: readonly MetricCardProps[];
  sentiment: SentimentDistributionProps;
  history: CallHistoryProps;
  loading?: boolean;
  notice?: string;
};

export function renderDashboardLayout({
  metrics,
  sentiment,
  history,
  loading = false,
  notice,
  ...navigation
}: DashboardLayoutProps) {
  return (
    <ApplicationLayout {...navigation} activePage="dashboard">
      <div className="space-y-8">
        <PageHeader
          title="Call Dashboard"
          subtitle="Explore sample conversations, agreements, and post-call analysis"
        />
        <p className="text-sm text-muted-foreground">
          Sample calls · Synthetic data · No sign-in required
        </p>
        {notice && <p role="status">{notice}</p>}
        {loading ? (
          <div
            role="status"
            aria-label="Loading dashboard"
            aria-busy="true"
            className="space-y-8"
          >
            <span className="sr-only">Loading dashboard</span>
            <div className="grid gap-4 xs:grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
              {[0, 1, 2, 3, 4].map((item) => (
                <Skeleton key={item} className="h-[132px]" />
              ))}
            </div>
            <Skeleton className="h-[124px]" />
            <Skeleton className="h-[506px]" />
          </div>
        ) : (
          <>
            <div
              aria-label="Call metrics"
              className="grid gap-4 xs:grid-cols-2 sm:grid-cols-3 xl:grid-cols-5"
            >
              {metrics.map((metric) => (
                <MetricCard key={metric.label} {...metric} />
              ))}
            </div>
            <SentimentDistribution {...sentiment} />
            <CallHistory {...history} />
          </>
        )}
      </div>
    </ApplicationLayout>
  );
}
