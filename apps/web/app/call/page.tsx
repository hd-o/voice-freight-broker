"use client";

import { useQuery } from "@tanstack/react-query";
import { callSchema } from "@voice-freight/contracts/calls";
import type { TranscriptEntry } from "@/components/call/transcript";
import { CallLayout } from "@/components/layouts/call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import { navigatePage } from "@/lib/navigation";
import { useAccount, requestApi } from "@/lib/account";
import { useLiveCall } from "@/lib/live";

export default function CallPage(): React.JSX.Element {
  const account = useAccount();
  const call = useLiveCall(account.user?.id);
  const analysis = useQuery({
    queryKey: ["private", account.user?.id, "call", call.status?.id],
    enabled: !!account.user && call.state === "ended" && !!call.status?.id,
    retry: false,
    refetchInterval: (query): number | false => (query.state.data?.analysis.status === "pending" ? 2000 : false),
    queryFn: async (): Promise<ReturnType<typeof callSchema.parse>> =>
      callSchema.parse(await (await requestApi(`/calls/${encodeURIComponent(call.status!.id)}`)).json()),
  });

  function exploreSamples(): void {
    navigatePage("dashboard");
  }

  return (
    <CallLayout
      analysis={account.user && call.state === "ended" ? analysis.data?.analysis : undefined}
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
      onExploreSamples={exploreSamples}
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
