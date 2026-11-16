"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { callsSchema } from "@voice-freight/contracts/calls";
import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { DashboardControls } from "@/components/dashboard/dashboard-controls";
import { sampleCalls } from "@/lib/samples";
import { createHistory, createMetrics } from "@/lib/reporting";
import { useAccount, requestApi } from "@/lib/account";
import { changeQuery, createCallHref, navigatePage, useQueryParameters } from "@/lib/navigation";

const pageSize = 5;

export default function DashboardPage(): React.JSX.Element {
  const { parameters, readiness } = useQueryParameters();
  const account = useAccount();
  const [feedback, setFeedback] = useState<string>();
  const [failure, setFailure] = useState(false);
  const [restocking, setRestocking] = useState(false);
  const [operationId, setOperationId] = useState<string>();

  const live = useQuery({
    queryKey: ["private", account.user?.id, "dashboard"],
    enabled: !!account.user,
    retry: false,
    refetchInterval: (query): number | false =>
      query.state.data?.some((call): boolean => !call.endedAt || call.analysis.status === "pending") ? 2000 : false,
    queryFn: async (): Promise<ReturnType<typeof callsSchema.parse>> => {
      const data: { calls: unknown } = await (await requestApi("/dashboard")).json();
      return callsSchema.parse(data.calls);
    },
  });

  const calls = [...sampleCalls, ...(account.user ? (live.data ?? []) : [])].sort((a, b): number =>
    b.startedAt.localeCompare(a.startedAt),
  );

  const history = createHistory(calls);
  const report = summarizeCalls(calls);
  const pageNumber = Number(parameters.get("page") ?? 1);
  const lastPage = Math.max(1, Math.ceil(history.length / pageSize));
  const currentPage = Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= lastPage ? pageNumber : 1;
  const offset = (currentPage - 1) * pageSize;

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
      loading={!readiness || account.loading || (!!account.user && live.isPending)}
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
      metrics={createMetrics(calls)}
      sentiment={{
        segments: report.sentiments,
        description: `${report.callCount} calls · One rating per call`,
      }}
      history={{
        rows: history.slice(offset, offset + pageSize),
        pageLabel: history.length
          ? `Showing ${offset + 1}–${Math.min(offset + pageSize, history.length)} of ${history.length} calls`
          : "0 calls",
        nextDisabled: currentPage === lastPage,
        previousVisible: currentPage > 1,
        getCallHref: (id): string => createCallHref(id, currentPage),
        onNext: (): void => selectPage(currentPage + 1),
        onPrevious: (): void => selectPage(currentPage - 1),
      }}
    />
  );
}
