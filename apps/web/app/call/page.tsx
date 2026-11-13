"use client";

import { renderCallLayout as CallLayout } from "@/components/layouts/call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import { navigatePage } from "@/lib/navigation";
import { useAccount } from "@/lib/account";
import { useState } from "react";

export default function renderCallPage() {
  const account = useAccount();
  const [notice, setNotice] = useState<string>();
  function explainAvailability() {
    setNotice(
      "Live voice calls will be available in Phase 3. Explore the synthetic sample calls.",
    );
  }

  function exploreSamples() {
    navigatePage("dashboard");
  }

  return (
    <CallLayout
      state="ready"
      signedIn={!!account.user}
      accountPending={account.pending}
      carriers={demoCarriers}
      entries={[]}
      notice={account.notice ?? notice}
      onNavigate={navigatePage}
      onAccountAction={account.performAccountAction}
      onExploreSamples={exploreSamples}
      onViewCall={exploreSamples}
      onStart={explainAvailability}
      onSignIn={account.performAccountAction}
      onMute={explainAvailability}
      onHangUp={explainAvailability}
      onNewCall={explainAvailability}
      onDismissNotification={explainAvailability}
      onNotificationAction={exploreSamples}
    />
  );
}
