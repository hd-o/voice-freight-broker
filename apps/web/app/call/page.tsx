"use client";

import { useRouter } from "next/navigation";

import type { TranscriptEntry } from "@/components/call/transcript";
import { CallLayout } from "@/components/layouts/call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import type { NavigationPage } from "@/components/navigation/navigation";
import { useAccount } from "@/lib/account";
import { useCallAnalysis } from "@/lib/analysis";
import { useLiveCall } from "@/lib/live";

export default function CallPage(): React.JSX.Element {
  const router = useRouter();
  const navigatePage = (page: NavigationPage): void => router.push(`/${page}`);
  const account = useAccount();
  const call = useLiveCall(account.user?.id);
  const analysis = useCallAnalysis(account.user?.id, call.status?.id, call.state === "ended");

  return (
    <CallLayout
      analysis={account.user && call.state === "ended" ? analysis.data : undefined}
      state={call.state}
      muted={call.muted}
      sampleAgentLevel={call.sampleAgentLevel}
      duration={`${String(Math.floor(call.elapsedSeconds / 60)).padStart(2, "0")}:${String(call.elapsedSeconds % 60).padStart(2, "0")}`}
      notification={call.notification}
      signedIn={!!account.user}
      accountName={account.user?.name}
      accountPending={account.pending}
      carriers={demoCarriers}
      transcriptFailure={call.transcriptFailure}
      onRetryTranscript={(): void => {
        void call.retryTranscript();
      }}
      entries={call.transcript.map((entry): TranscriptEntry => ({
        ...entry,
        label: entry.speaker === "carrier" ? "You" : "Northstar",
        time: `${String(Math.floor(entry.startMs / 60_000)).padStart(2, "0")}:${String(Math.floor(entry.startMs / 1000) % 60).padStart(2, "0")}`,
      }))}
      notice={account.notice ?? call.notice}
      onNavigate={navigatePage}
      onAccountAction={account.performAccountAction}
      callHref={call.status ? `/dashboard/call?call=${encodeURIComponent(call.status.id)}` : undefined}
      onStart={(): void => {
        void call.start();
      }}
      onSignIn={account.performAccountAction}
      onMute={call.toggleMute}
      onHangUp={(): void => {
        void call.hangUp();
      }}
      onNewCall={call.reset}
      onDismissNotification={call.dismissNotification}
      onNotificationAction={(): void => {
        void call.start();
      }}
    />
  );
}
