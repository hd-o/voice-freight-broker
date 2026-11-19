"use client";

import { useRouter } from "next/navigation";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { dashboardSchema, summarizeCalls } from "@voice-freight/contracts/reporting";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { sampleCalls } from "@/lib/samples";
import { createHistory, createReportMetrics, mergeReports } from "@/lib/reporting";
import { useAccount, requestApi } from "@/lib/account";
import { changeQuery, createCallHref, useQueryParameters } from "@/lib/navigation";

const pageSize = 5;

export default function DashboardPage(): React.JSX.Element {
  const router = useRouter();
  const navigatePage = (page: "call" | "dashboard"): void => router.push(`/${page}`);
  const { parameters, readiness } = useQueryParameters();
  const account = useAccount();
  const [feedback, setFeedback] = useState<string>();
  const [failure, setFailure] = useState(false);
  const [restocking, setRestocking] = useState(false);
  const [operationId, setOperationId] = useState<string>();

  const pageNumber = Number(parameters.get("page") ?? 1);
  const requestedPage = Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1;

  const live = useQuery({
    queryKey: ["private", account.user?.id, "dashboard", requestedPage],
    enabled: !!account.user,
    retry: false,
    queryFn: async (): Promise<ReturnType<typeof dashboardSchema.parse>> => {
      const samples = sampleCalls.map(({ id, startedAt }) => ({ id, startedAt }));
      const query = new URLSearchParams({ page: String(requestedPage), samples: JSON.stringify(samples) });
      return dashboardSchema.parse(await (await requestApi(`/dashboard?${query}`)).json());
    },
  });

  const pending = live.data?.pending ?? [];
  const nextRetry =
    pending.length && pending.every((entry): boolean => !!entry.endedAt && !!entry.analysis.retryAt)
      ? Math.min(...pending.map((entry): number => Date.parse(entry.analysis.retryAt!)))
      : 0;
  const status = useQuery({
    queryKey: ["private", account.user?.id, "dashboard-status", live.data?.version],
    enabled: !!account.user && !!live.data && pending.length > 0,
    retry: false,
    refetchInterval: (): number => Math.max(2000, Math.min(30_000, nextRetry - Date.now())),
    queryFn: async (): Promise<{ version: string }> => {
      const query = new URLSearchParams({ ids: JSON.stringify(pending.map((entry) => entry.id)) });
      return z.object({ version: z.string() }).parse(await (await requestApi(`/dashboard/status?${query}`)).json());
    },
  });

  useEffect((): void => {
    if (status.data && live.data && status.data.version !== live.data.version) {
      void live.refetch();
    }
  }, [status.data, live.data, live.refetch]);

  const sampleReport = summarizeCalls(sampleCalls);
  const report = account.user && live.data ? mergeReports(sampleReport, live.data.report) : sampleReport;
  const count = account.user && live.data ? live.data.count : sampleCalls.length;
  const lastPage = Math.max(1, Math.ceil(count / pageSize));
  const currentPage = account.user && live.data ? live.data.page : requestedPage <= lastPage ? requestedPage : 1;
  const offset = (currentPage - 1) * pageSize;
  const samples =
    account.user && live.data
      ? sampleCalls.filter((call): boolean => live.data!.sampleIds.includes(call.id))
      : sampleCalls
          .slice()
          .sort((a, b): number => b.startedAt.localeCompare(a.startedAt))
          .slice(offset, offset + pageSize);
  const calls = [...samples, ...(account.user ? (live.data?.calls ?? []) : [])].sort((a, b): number =>
    b.startedAt.localeCompare(a.startedAt),
  );
  const history = createHistory(calls);

  function selectPage(page: number): void {
    parameters.set("page", String(page));
    changeQuery(parameters);
  }

  async function restock(): Promise<void> {
    const id = operationId ?? crypto.randomUUID();
    setOperationId(id);
    setRestocking(true);
    setFeedback(undefined);
    setFailure(false);

    try {
      const result: { added: number } = await (
        await requestApi("/inventory/restock", "POST", { operationId: id })
      ).json();

      setFeedback(
        result.added
          ? `Added ${result.added} loads. Existing calls keep their inventory.`
          : "This restock already completed. Existing history is preserved.",
      );

      setOperationId(undefined);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Restocking failed. Try again.");
      setFailure(true);
    } finally {
      setRestocking(false);
    }
  }

  return (
    <DashboardLayout
      signedIn={!!account.user}
      accountName={account.user?.name}
      accountPending={account.pending}
      onNavigate={navigatePage}
      onAccountAction={account.performAccountAction}
      notice={account.notice ?? live.error?.message}
      loading={!readiness}
      controls={
        account.user?.role === "administrator" && (
          <DashboardControls
            restocking={restocking}
            feedback={feedback}
            error={failure}
            onRestock={(): void => {
              void restock();
            }}
          />
        )
      }
      metrics={createReportMetrics(report)}
      sentiment={{
        segments: report.sentiments,
        description: `${report.callCount} calls · One rating per call`,
      }}
      history={{
        rows: history,
        pageLabel: count ? `Showing ${offset + 1}–${Math.min(offset + pageSize, count)} of ${count} calls` : "0 calls",
        nextDisabled: currentPage === lastPage,
        previousVisible: currentPage > 1,
        getCallHref: (id): string => createCallHref(id, currentPage),
        onNext: (): void => selectPage(currentPage + 1),
        onPrevious: (): void => selectPage(currentPage - 1),
      }}
    />
  );
}
