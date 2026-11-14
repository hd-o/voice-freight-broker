"use client";

import { renderCallLayout as CallLayout } from "@/components/layouts/call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import { navigatePage } from "@/lib/navigation";
import { useAccount } from "@/lib/account";
import { useLiveCall } from "@/lib/live";

export default function renderCallPage() {
  const account = useAccount();
  const call = useLiveCall(account.user?.id);

  function exploreSamples() {
    navigatePage("dashboard");
  }

  return (
    <CallLayout
      state={call.state}
      muted={call.muted}
      duration={`${String(Math.floor(call.elapsedSeconds / 60)).padStart(2, "0")}:${String(call.elapsedSeconds % 60).padStart(2, "0")}`}
      notification={call.notification}
      signedIn={!!account.user}
      accountName={account.user?.name}
      accountPending={account.pending}
      carriers={demoCarriers}
      entries={(call.status?.transcript ?? []).map((entry) => ({
        ...entry,
        label: entry.speaker === "carrier" ? "You" : "Northstar",
        time: `${String(Math.floor(entry.startMs / 60_000)).padStart(2, "0")}:${String(Math.floor(entry.startMs / 1000) % 60).padStart(2, "0")}`,
      }))}
      notice={account.notice ?? call.notice}
      onNavigate={navigatePage}
      onAccountAction={account.performAccountAction}
      onExploreSamples={exploreSamples}
      onViewCall={() => {
        if (call.status) {
          window.location.assign(`/dashboard/call?call=${encodeURIComponent(call.status.id)}`);
        }
      }}
      onStart={() => {
        void call.start();
      }}
      onSignIn={account.performAccountAction}
      onMute={call.toggleMute}
      onHangUp={() => {
        void call.hangUp();
      }}
      onNewCall={call.reset}
      onDismissNotification={call.dismissNotification}
      onNotificationAction={() => {
        void call.start();
      }}
    />
  );
}
