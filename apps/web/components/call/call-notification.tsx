import { AlertCircle, CircleHelp, LoaderCircle, X } from "lucide-react";
import { renderButton as Button } from "@/components/ui/button";
import { mergeClasses } from "@/lib/classes";

export type CallNotificationKind =
  | "analysis"
  | "microphone"
  | "connection"
  | "interruption"
  | "analysisFailure"
  | "dailyLimit"
  | "inactivity";

export type CallNotificationProps = {
  kind: CallNotificationKind;
  administrator?: boolean;
  onDismiss: () => void;
  onAction: () => void;
  className?: string;
};

const notifications: Record<CallNotificationKind, { title: string; description: string; action?: string }> = {
  analysis: {
    title: "Analyzing call",
    description: "Your call is saved. Summary and sentiment analysis are pending.",
  },
  microphone: {
    title: "Microphone access blocked",
    description: "Allow microphone access in your browser, then try again.",
    action: "Retry microphone",
  },
  connection: {
    title: "Couldn’t connect",
    description: "We couldn’t reach the voice service. Check your connection and try again.",
    action: "Retry connection",
  },
  interruption: {
    title: "Call interrupted",
    description: "Your partial transcript and recorded agreements are saved.",
    action: "View call",
  },
  analysisFailure: {
    title: "Analysis failed",
    description: "The call is saved. An administrator can retry the analysis.",
    action: "Retry analysis",
  },
  dailyLimit: {
    title: "Daily call limit reached",
    description: "6 calls made today. Try again tomorrow or browse sample calls",
    action: "Browse sample calls",
  },
  inactivity: {
    title: "Are you still there?",
    description: "This call ends in 15 seconds without caller speech. Speak to keep it active.",
  },
};

export function renderCallNotification({
  kind,
  administrator = false,
  onDismiss,
  onAction,
  className,
}: CallNotificationProps) {
  const notification = notifications[kind];
  const failure =
    kind === "microphone" || kind === "connection" || kind === "interruption" || kind === "analysisFailure";

  return (
    <aside
      role={failure ? "alert" : "status"}
      className={mergeClasses(
        "w-full max-w-[400px] rounded-[10px] border border-border bg-surface p-4 shadow-[0_4px_16px_#00000014]",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        {kind === "analysis" ? (
          <LoaderCircle className="mt-0.5 size-5 shrink-0 motion-safe:animate-spin" aria-hidden />
        ) : kind === "inactivity" ? (
          <CircleHelp className="mt-0.5 size-5 shrink-0" aria-hidden />
        ) : (
          <AlertCircle
            className={mergeClasses("mt-0.5 size-5 shrink-0", failure && "text-destructive-foreground")}
            aria-hidden
          />
        )}
        <h2 className="min-w-0 flex-1 font-medium">{notification.title}</h2>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={`Dismiss ${notification.title.toLowerCase()}`}
          className="-m-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
        >
          <X size={16} aria-hidden />
        </button>
      </div>
      <p className="mt-2.5 text-xs leading-[18px] text-muted-foreground">{notification.description}</p>
      {notification.action && (
        <div className="mt-2.5 flex flex-wrap items-center justify-end gap-3">
          {kind === "analysisFailure" && (
            <span className="text-xs leading-4 text-muted-foreground">Administrator only</span>
          )}
          {(kind !== "analysisFailure" || administrator) && (
            <Button variant="outline" size="small" onClick={onAction}>
              {notification.action}
            </Button>
          )}
        </div>
      )}
    </aside>
  );
}
