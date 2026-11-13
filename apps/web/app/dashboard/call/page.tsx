"use client";

import { renderCallDetailLayout as CallDetailLayout } from "@/components/layouts/call-detail-layout";
import type { NavigationPage } from "@/components/navigation/navigation";
import { sampleCalls } from "@/lib/samples";
import { createCallDetail } from "@/lib/reporting";
import {
  changeQuery,
  navigatePage,
  useQueryParameters,
} from "@/lib/navigation";
import { useAccount, requestApi } from "@/lib/account";
import { useQuery } from "@tanstack/react-query";
import { callSchema } from "@voice-freight/contracts/calls";

export default function renderCallDetailsPage() {
  const { parameters, readiness } = useQueryParameters();
  const account = useAccount();
  const selection = parameters.get("call");
  const sample = sampleCalls.find((call) => call.id === selection);
  const privateSelection = selection !== null && !sample;
  const live = useQuery({
    queryKey: ["private", account.user?.id, "call", selection],
    enabled: privateSelection && !!account.user,
    retry: false,
    queryFn: async () =>
      callSchema.parse(
        await (
          await requestApi(`/calls/${encodeURIComponent(selection!)}`)
        ).json(),
      ),
  });
  const call = sample ?? (account.user ? live.data : undefined);

  function selectLoad(id: string | null) {
    if (id === null) {
      parameters.delete("load");
    } else {
      parameters.set("load", id);
    }

    changeQuery(parameters);
  }

  function navigateSection(page: NavigationPage) {
    if (page !== "dashboard") {
      navigatePage(page);
      return;
    }

    const historyPage = parameters.get("page");
    const query = new URLSearchParams();

    if (historyPage !== null) {
      query.set("page", historyPage);
    }
    window.location.assign(`/dashboard${query.size ? `?${query}` : ""}`);
  }

  return (
    <CallDetailLayout
      signedIn={!!account.user}
      accountPending={account.pending}
      onNavigate={navigateSection}
      onAccountAction={account.performAccountAction}
      notice={
        account.notice ??
        (privateSelection && !account.user
          ? "Sign in to view this private call."
          : live.error?.message)
      }
      loading={
        !readiness ||
        account.loading ||
        (privateSelection && !!account.user && live.isPending)
      }
      unavailable={selection !== null && !call}
      record={
        call ? createCallDetail(call, parameters.get("load"), selectLoad) : null
      }
    />
  );
}
