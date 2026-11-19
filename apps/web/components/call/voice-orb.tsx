"use client";

import { useEffect, useRef } from "react";
import { mergeClasses } from "@/lib/classes";

export type VoiceOrbProps = { connected?: boolean; className?: string; sampleAgentLevel?: () => number };

export function VoiceOrb({ connected = false, className, sampleAgentLevel }: VoiceOrbProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!connected || !canvas.current) {
      return;
    }

    const element = canvas.current;
    let active = true;
    let destroy: (() => void) | undefined;

    void import("./orb-renderer")
      .then(({ createOrbRenderer }): void => {
        if (active) {
          destroy = createOrbRenderer(element, sampleAgentLevel);
        }
      })
      .catch((): void => {
        // The static image remains available if the renderer cannot load.
      });

    return (): void => {
      active = false;
      destroy?.();
    };
  }, [connected, sampleAgentLevel]);

  return (
    <div
      className={mergeClasses("relative aspect-square w-[252px] max-w-full shrink-0", className)}
      role="img"
      aria-label={connected ? "Voice connection active" : "Voice connection inactive"}
    >
      <img
        src="/images/voice-orb.png"
        alt=""
        width={252}
        height={252}
        className={mergeClasses("absolute inset-0 h-full w-full", !connected && "grayscale brightness-60 contrast-75")}
      />
      {connected && <canvas ref={canvas} className="absolute inset-0 h-full w-full opacity-0" aria-hidden="true" />}
    </div>
  );
}
