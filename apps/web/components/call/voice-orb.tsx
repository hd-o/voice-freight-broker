"use client";

import { useEffect, useRef } from "react";
import { mergeClasses } from "@/lib/classes";
import { createOrbRenderer } from "./orb-renderer";

export type VoiceOrbProps = { connected?: boolean; className?: string };

export function VoiceOrb({ connected = false, className }: VoiceOrbProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect((): (() => void) | undefined => {
    if (!connected || !canvas.current) {
      return;
    }

    return createOrbRenderer(canvas.current);
  }, [connected]);

  return (
    <div
      className={mergeClasses("relative aspect-square w-[280px] max-w-full shrink-0", className)}
      role="img"
      aria-label={connected ? "Voice connection active" : "Voice connection inactive"}
    >
      <img
        src="/images/voice-orb.png"
        alt=""
        width={280}
        height={280}
        className={mergeClasses("absolute inset-0 h-full w-full", !connected && "grayscale brightness-60 contrast-75")}
      />
      {connected && <canvas ref={canvas} className="absolute inset-0 h-full w-full opacity-0" aria-hidden="true" />}
    </div>
  );
}
