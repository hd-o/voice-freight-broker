"use client";

import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { renderDashboardLayout as DashboardLayout } from "@/components/layouts/dashboard-layout";
import { sampleCalls } from "@/lib/samples";
import { createHistory, createMetrics } from "@/lib/reporting";
import {
  changeQuery,
  createCallHref,
  navigatePage,
  usePublicAccount,
  useQueryParameters,
} from "@/lib/navigation";

const pageSize = 5;
const history = createHistory(sampleCalls);
const metrics = createMetrics(sampleCalls);
const report = summarizeCalls(sampleCalls);

export default function renderDashboardPage() {
  const { parameters, readiness } = useQueryParameters();
  const { notice, explainAvailability } = usePublicAccount();
  const pageNumber = Number(parameters.get("page") ?? 1);
  const lastPage = Math.ceil(history.length / pageSize);
  const currentPage =
    Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= lastPage
      ? pageNumber
      : 1;
  const offset = (currentPage - 1) * pageSize;

  function selectPage(page: number) {
    parameters.set("page", String(page));
    changeQuery(parameters);
  }

  return (
    <DashboardLayout
      signedIn={false}
      onNavigate={navigatePage}
      onAccountAction={explainAvailability}
      notice={notice}
      loading={!readiness}
      metrics={metrics}
      sentiment={{
        segments: report.sentiments,
        description: `${report.callCount} calls · One rating per call`,
      }}
      history={{
        rows: history.slice(offset, offset + pageSize),
        pageLabel: `Showing ${offset + 1}–${Math.min(offset + pageSize, history.length)} of ${history.length} sample calls`,
        nextDisabled: currentPage === lastPage,
        previousVisible: currentPage > 1,
        getCallHref: (id) => createCallHref(id, currentPage),
        onNext: () => selectPage(currentPage + 1),
        onPrevious: () => selectPage(currentPage - 1),
      }}
    />
  );
}
