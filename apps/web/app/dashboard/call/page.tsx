"use client";

import { useRouter } from "next/navigation";

import { CallDetailLayout } from "@/components/layouts/call-detail-layout";
import type { NavigationPage } from "@/components/navigation/navigation";
import { sampleCalls } from "@/lib/samples";
import { createCallDetail } from "@/lib/reporting";
import { changeQuery, useQueryParameters } from "@/lib/navigation";
import { useAccount, requestApi } from "@/lib/account";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { callSchema } from "@voice-freight/contracts/calls";

export default function CallDetailsPage(): React.JSX.Element {
  const router = useRouter();
  const navigatePage = (page: NavigationPage): void => router.push(`/${page}`);
  const { parameters, readiness } = useQueryParameters();
  const account = useAccount();
  const queryClient = useQueryClient();
  const selection = parameters.get("call");
  const sample = sampleCalls.find((call): boolean => call.id === selection);
  const privateSelection = selection !== null && !sample;

  const live = useQuery({
    queryKey: ["private", account.user?.id, "call", selection],
    enabled: privateSelection && !!account.user,
    retry: false,
    refetchInterval: (query): number | false => (query.state.data?.analysis.status === "pending" ? 2000 : false),
    queryFn: async (): Promise<ReturnType<typeof callSchema.parse>> =>
      callSchema.parse(await (await requestApi(`/calls/${encodeURIComponent(selection!)}`)).json()),
  });

  const retry = useMutation({
    mutationFn: async (): Promise<void> => {
      await requestApi(`/calls/${encodeURIComponent(selection!)}/analysis/retry`, "POST", {
        version: live.data?.analysis.version,
      });
    },
    onSuccess: async (): Promise<void> => {
      await queryClient.invalidateQueries({ queryKey: ["private", account.user?.id] });
    },
  });

  const call = sample ?? (account.user ? live.data : undefined);

  function selectLoad(id: string | null): void {
    if (id === null) {
      parameters.delete("load");
    } else {
      parameters.set("load", id);
    }

    changeQuery(parameters);
  }

  function navigateSection(page: NavigationPage): void {
    if (page !== "dashboard") {
      navigatePage(page);
      return;
    }

    const historyPage = parameters.get("page");
    const query = new URLSearchParams();

    if (historyPage !== null) {
      query.set("page", historyPage);
    }

    router.push(`/dashboard${query.size ? `?${query}` : ""}`);
  }

  const detail = call ? createCallDetail(call, parameters.get("load"), selectLoad) : null;

  if (detail && call?.source === "Live") {
    detail.analysis = {
      ...detail.analysis,
      administrator: account.user?.role === "administrator",
      onRetry: (): void => retry.mutate(),
      retrying: retry.isPending,
      error: retry.error?.message,
      reason: call.analysis.reason,
      retryAt: call.analysis.retryAt,
    };
  }

  return (
    <CallDetailLayout
      signedIn={!!account.user}
      accountName={account.user?.name}
      accountPending={account.pending}
      onNavigate={navigateSection}
      onAccountAction={account.performAccountAction}
      notice={
        account.notice ??
        (privateSelection && !account.user ? "Sign in to view this private call." : live.error?.message)
      }
      loading={!readiness || account.loading || (privateSelection && !!account.user && live.isPending)}
      unavailable={selection !== null && !call}
      record={detail}
    />
  );
}
