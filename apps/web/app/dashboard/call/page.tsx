"use client";

import { renderCallDetailLayout as CallDetailLayout } from "@/components/layouts/call-detail-layout";
import type { NavigationPage } from "@/components/navigation/navigation";
import { sampleCalls } from "@/lib/samples";
import { createCallDetail } from "@/lib/reporting";
import {
  changeQuery,
  navigatePage,
  usePublicAccount,
  useQueryParameters,
} from "@/lib/navigation";

export default function renderCallDetailsPage() {
  const { parameters, readiness } = useQueryParameters();
  const { notice, explainAvailability } = usePublicAccount();
  const selection = parameters.get("call");
  const call = sampleCalls.find((call) => call.id === selection);

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
      signedIn={false}
      onNavigate={navigateSection}
      onAccountAction={explainAvailability}
      notice={notice}
      loading={!readiness}
      unavailable={selection !== null && !call}
      record={
        call ? createCallDetail(call, parameters.get("load"), selectLoad) : null
      }
    />
  );
}
