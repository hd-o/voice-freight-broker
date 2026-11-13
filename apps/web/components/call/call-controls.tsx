import { renderButton as Button } from "@/components/ui/button";

export type CallControlsProps = {
  state: "ready" | "connected" | "ended";
  signedIn?: boolean;
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
  muted = false,
  onStart,
  onSignIn,
  onMute,
  onHangUp,
  onNewCall,
}: CallControlsProps) {
  if (state === "connected") {
    return (
      <div
        className="flex flex-wrap justify-center gap-3"
        aria-label="Call controls"
      >
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
    <Button onClick={signedIn ? onStart : onSignIn}>
      {signedIn ? "Start call" : "Sign in to start a call"}
    </Button>
  );
}
