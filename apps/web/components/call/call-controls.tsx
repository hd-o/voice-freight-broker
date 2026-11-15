import { renderButton as Button } from "@/components/ui/button";

export type CallControlsProps = {
  state: "ready" | "connecting" | "connected" | "ending" | "ended";
  signedIn?: boolean;
  accountPending?: boolean;
  muted?: boolean;
  onStart: () => void;
  onSignIn: () => void;
  onMute: () => void;
  onHangUp: () => void;
  onNewCall: () => void;
};

export function renderCallControls({
  state,
  signedIn = false,
  accountPending = false,
  muted = false,
  onStart,
  onSignIn,
  onMute,
  onHangUp,
  onNewCall,
}: CallControlsProps): React.JSX.Element {
  if (state === "connecting") {
    return (
      <div className="flex flex-wrap justify-center gap-3">
        <Button disabled>Connecting…</Button>
        <Button variant="outline" onClick={onHangUp}>
          Cancel call
        </Button>
      </div>
    );
  }
  if (state === "ending") {
    return <Button disabled>Saving call…</Button>;
  }
  if (state === "connected") {
    return (
      <div className="flex flex-wrap justify-center gap-3" aria-label="Call controls">
        <Button variant="outline" aria-pressed={muted} onClick={onMute}>
          {muted ? "Unmute" : "Mute"}
        </Button>
        <Button variant="destructive" onClick={onHangUp}>
          Hang up
        </Button>
      </div>
    );
  }

  if (state === "ended") {
    return (
      <Button onClick={onNewCall} className="max-w-full whitespace-normal">
        Clear and Start New Call
      </Button>
    );
  }

  return (
    <Button disabled={accountPending} onClick={signedIn ? onStart : onSignIn}>
      {signedIn ? "Start call" : "Sign in to start a call"}
    </Button>
  );
}
