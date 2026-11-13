"use client";

import { renderCallLayout as CallLayout } from "@/components/layouts/call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import { navigatePage, usePublicAccount } from "@/lib/navigation";

export default function renderCallPage() {
  const { notice, explainAvailability } = usePublicAccount();

  function exploreSamples() {
    navigatePage("dashboard");
  }

  return (
    <CallLayout
      state="ready"
      signedIn={false}
      carriers={demoCarriers}
      entries={[]}
      notice={notice}
      onNavigate={navigatePage}
      onAccountAction={explainAvailability}
      onExploreSamples={exploreSamples}
      onViewCall={exploreSamples}
      onStart={explainAvailability}
      onSignIn={explainAvailability}
      onMute={explainAvailability}
      onHangUp={explainAvailability}
      onNewCall={explainAvailability}
      onDismissNotification={explainAvailability}
      onNotificationAction={exploreSamples}
    />
  );
}
