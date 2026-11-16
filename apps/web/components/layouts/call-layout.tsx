"use client";

import type { Call } from "@voice-freight/contracts/calls";
import { ApplicationLayout, type ApplicationLayoutProps } from "./application-layout";
import { PageHeader } from "@/components/navigation/page-header";
import { CallerBriefing, type DemoCarrier } from "@/components/call/caller-briefing";
import { CallIntroduction } from "@/components/call/call-introduction";
import { CallControls, type CallControlsProps } from "@/components/call/call-controls";
import { VoiceOrb } from "@/components/call/voice-orb";
import { Transcript, type TranscriptEntry } from "@/components/call/transcript";
import { CallNotification, type CallNotificationKind } from "@/components/call/call-notification";

export type CallLayoutProps = CallControlsProps & {
  analysis?: Call["analysis"];
  signedIn: boolean;
  accountName?: string;
  duration?: string;
  carriers: readonly DemoCarrier[];
  entries: readonly TranscriptEntry[];
  notification?: CallNotificationKind;
  administrator?: boolean;
  onNavigate: ApplicationLayoutProps["onNavigate"];
  onAccountAction: () => void;
  onExploreSamples: () => void;
  onViewCall: () => void;
  onDismissNotification: () => void;
  onNotificationAction: () => void;
  notice?: string;
  transcriptFailure?: boolean;
  onRetryTranscript?: () => void;
};

export function CallLayout({
  state,
  analysis,
  signedIn,
  accountName,
  accountPending,
  muted,
  duration = "00:00",
  carriers,
  entries,
  notification,
  administrator,
  onNavigate,
  onAccountAction,
  onExploreSamples,
  onViewCall,
  onDismissNotification,
  onNotificationAction,
  notice,
  transcriptFailure,
  onRetryTranscript,
  ...actions
}: CallLayoutProps): React.JSX.Element {
  const status =
    state === "ready"
      ? "Ready when you are"
      : state === "connecting"
        ? "Connecting…"
        : state === "ending"
          ? "Saving call…"
          : state === "connected"
            ? `${muted ? "Muted" : "Connected"} · ${duration}`
            : `Call ended · ${duration}`;

  return (
    <ApplicationLayout
      activePage="call"
      signedIn={signedIn}
      accountName={accountName}
      accountPending={accountPending}
      onNavigate={onNavigate}
      onAccountAction={onAccountAction}
    >
      <PageHeader
        title="Voice Call Demo"
        subtitle="Play the carrier, find a load, and negotiate with the voice agent."
      />
      {notice && (
        <p role="status" className="mt-4 rounded-lg bg-muted p-4">
          {notice}
        </p>
      )}
      <div className="mt-8 grid min-w-0 items-start gap-8 xl:grid-cols-[392px_minmax(0,1fr)]">
        <CallerBriefing carriers={carriers} className="xl:min-h-[492px]" />
        <div className="grid min-w-0 overflow-hidden rounded-[10px] border border-border bg-surface md:grid-cols-[minmax(0,1.18fr)_minmax(0,1fr)]">
          {state === "ready" ? (
            <CallIntroduction onExploreSamples={onExploreSamples} className="min-h-[360px] md:min-h-[490px]" />
          ) : (
            <div className="flex min-w-0 flex-col bg-muted md:h-[490px]">
              <Transcript
                entries={entries}
                autoScroll
                className="max-h-[490px] min-h-[360px] flex-1 rounded-none md:min-h-0"
              />
              {transcriptFailure && (
                <div role="alert" className="px-6 pb-4 text-sm">
                  <p>Could not load the saved transcript.</p>
                  <button type="button" onClick={onRetryTranscript} className="underline">
                    Retry saved transcript
                  </button>
                </div>
              )}
              {state === "ended" && (
                <div className="space-y-2 px-6 pb-6">
                  {analysis && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {analysis.status === "complete"
                        ? "Analysis complete. View the summary and sentiment in your dashboard."
                        : analysis.status === "failed"
                          ? "Analysis failed. An administrator can retry from the call details."
                          : analysis.reason === "allowance"
                            ? "Analysis is waiting for the monthly allowance to renew."
                            : "Analysis pending. Your summary and sentiment will appear when complete."}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={onViewCall}
                    className="text-sm font-medium underline-offset-4 hover:underline"
                  >
                    View this call in dashboard →
                  </button>
                </div>
              )}
            </div>
          )}
          <section
            className="flex min-w-0 flex-col items-center justify-between gap-8 p-6 md:min-h-[490px]"
            aria-label="Call information"
          >
            <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-xs leading-4">{status}</span>
            <VoiceOrb connected={state === "connected"} />
            <CallControls
              state={state}
              signedIn={signedIn}
              accountPending={accountPending}
              muted={muted}
              {...actions}
            />
          </section>
        </div>
      </div>
      {notification && (
        <div className="fixed top-4 right-4 left-4 z-40 flex justify-end md:left-auto">
          <CallNotification
            kind={notification}
            administrator={administrator}
            onDismiss={onDismissNotification}
            onAction={onNotificationAction}
          />
        </div>
      )}
    </ApplicationLayout>
  );
}
