"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  liveConnectionSchema,
  liveStatusSchema,
  type LiveStatus,
  type TranscriptFragment,
} from "@voice-freight/contracts/live";
import type { CallNotificationKind } from "@/components/call/call-notification";
import { requestApi } from "./account";
import { createTranscriptSession, type TranscriptSession } from "./transcript";

export function useLiveCall(userId?: string): {
  state: "ready" | "connecting" | "connected" | "ending" | "ended";
  status: LiveStatus | undefined;
  transcript: TranscriptFragment[];
  transcriptFailure: boolean;
  retryTranscript: () => Promise<void>;
  notice: string | undefined;
  notification: CallNotificationKind | undefined;
  muted: boolean;
  elapsedSeconds: number;
  sampleAgentLevel: () => number;
  start: () => Promise<void>;
  hangUp: (interrupted?: boolean) => Promise<void>;
  toggleMute: () => void;
  reset: () => void;
  dismissNotification: () => void;
} {
  const cache = useQueryClient();
  const [state, setState] = useState<"ready" | "connecting" | "connected" | "ending" | "ended">("ready");
  const [transcript, setTranscript] = useState<TranscriptFragment[]>([]);
  const [transcriptFailure, setTranscriptFailure] = useState(false);
  const [status, setStatus] = useState<LiveStatus>();
  const [notice, setNotice] = useState<string>();
  const [notification, setNotification] = useState<CallNotificationKind>();
  const [muted, setMuted] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const session = useRef<{
    id?: string;
    peer?: RTCPeerConnection;
    stream?: MediaStream;
    audio?: HTMLAudioElement;
    audioContext?: AudioContext;
    analyser?: AnalyserNode;
    audioSource?: MediaStreamAudioSourceNode;
    audioSamples?: Float32Array<ArrayBuffer>;
    transcript?: TranscriptSession;
    generation: number;
  }>({ generation: 0 });

  const busy = useRef(false);

  const dispose = useCallback((): void => {
    const current = session.current;
    current.stream?.getTracks().forEach((track): void => track.stop());

    if (current.peer) {
      current.peer.onconnectionstatechange = null;
      current.peer.ontrack = null;
      current.peer.close();
    }

    current.audioSource?.disconnect();
    current.analyser?.disconnect();

    if (current.audioContext && current.audioContext.state !== "closed") {
      void current.audioContext.close().catch((): void => {});
    }

    if (current.audio) {
      current.audio.pause();
      current.audio.srcObject = null;
    }

    current.peer = undefined;
    current.stream = undefined;
    current.audio = undefined;
    current.audioContext = undefined;
    current.analyser = undefined;
    current.audioSource = undefined;
    current.audioSamples = undefined;
  }, []);

  const sampleAgentLevel = useCallback((): number => {
    const { audio, audioContext, analyser, audioSamples } = session.current;

    if (!audio || audio.paused || audioContext?.state !== "running" || !analyser || !audioSamples) {
      return 0;
    }

    analyser.getFloatTimeDomainData(audioSamples);
    let energy = 0;

    for (const sample of audioSamples) {
      energy += sample * sample;
    }

    return Math.min(1, Math.sqrt(energy / audioSamples.length) * 6);
  }, []);

  const hangUp = useCallback(
    async (interrupted = false): Promise<void> => {
      const id = session.current.id;
      const generation = session.current.generation;
      const transcriptSession = session.current.transcript;

      if (!id) {
        session.current.generation++;
        busy.current = false;
        session.current.transcript?.cancel();
        dispose();
        setState("ready");
        return;
      }

      setState("ending");

      session.current.stream?.getTracks().forEach((track): void => {
        track.enabled = false;
      });

      try {
        await requestApi(`/calls/${encodeURIComponent(id)}/hangup`, "POST", {
          interrupted,
        });

        if (session.current.generation !== generation) {
          return;
        }

        void cache.invalidateQueries({ queryKey: ["private"] });
      } catch (error) {
        if (session.current.generation !== generation) {
          return;
        }

        transcriptSession?.suspend();
        setTranscriptFailure(true);
        dispose();
        setState("ended");

        setNotice(
          error instanceof Error ? error.message : "Could not finish the call. Your saved record remains available.",
        );
      }
    },
    [cache, dispose],
  );

  useEffect((): void | (() => void) => {
    setState("ready");
    setStatus(undefined);
    setTranscript([]);
    setTranscriptFailure(false);
    setNotice(undefined);
    setNotification(undefined);
    setElapsedSeconds(0);

    function abandon(): void {
      const id = session.current.id;

      if (id) {
        navigator.sendBeacon(
          `/api/calls/${encodeURIComponent(id)}/hangup`,
          new Blob([JSON.stringify({ interrupted: true })], {
            type: "application/json",
          }),
        );
      }

      session.current.generation++;
      session.current.transcript?.cancel();
      dispose();
      session.current.id = undefined;
    }

    window.addEventListener("pagehide", abandon);

    return (): void => {
      window.removeEventListener("pagehide", abandon);
      abandon();
    };
  }, [userId, dispose]);

  useEffect((): void | (() => void) => {
    if (!status?.startedAt || state === "ready") {
      return;
    }

    const startedAt = Date.parse(status.startedAt);
    const endedAt = status.endedAt ? Date.parse(status.endedAt) : undefined;

    function updateElapsed(): void {
      setElapsedSeconds(Math.max(0, Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000)));
    }

    updateElapsed();

    if (endedAt !== undefined || state === "ended") {
      return;
    }

    const timer = window.setInterval(updateElapsed, 1000);
    return (): void => window.clearInterval(timer);
  }, [status?.startedAt, status?.endedAt, state]);

  useEffect((): void | (() => void) => {
    if (!status?.id || state === "ready" || status.state === "ended") {
      return;
    }

    let active = true;
    let failures = 0;
    let timer: number | undefined;

    async function refresh(): Promise<void> {
      try {
        const result = liveStatusSchema.parse(
          await (await requestApi(`/calls/${encodeURIComponent(status!.id)}/live`)).json(),
        );

        if (!active) {
          return;
        }

        failures = 0;
        setStatus(result);

        if (state !== "ended" || result.state === "ended") {
          setState(
            result.state === "connected" && session.current.peer && session.current.peer.connectionState !== "connected"
              ? "connecting"
              : result.state,
          );
        }

        if (result.state === "ending") {
          session.current.stream?.getAudioTracks().forEach((track): void => {
            track.enabled = false;
          });
        }

        if (result.state === "ended") {
          active = false;
          void session.current.transcript?.complete();
          dispose();
          void cache.invalidateQueries({ queryKey: ["private"] });
        } else {
          timer = window.setTimeout(refresh, result.state === "connected" && state !== "ended" ? 5000 : 1000);
        }
      } catch (error) {
        if (active) {
          failures++;

          if (failures < 3) {
            timer = window.setTimeout(refresh, 1000);
            return;
          }

          active = false;
          const transcriptSession = session.current.transcript;
          transcriptSession?.suspend();
          setTranscriptFailure(true);
          dispose();
          setState("ended");

          setStatus((current): LiveStatus | undefined =>
            current ? { ...current, state: "ended", notice: null } : current,
          );

          setNotice(error instanceof Error ? error.message : "Call status unavailable.");

          void requestApi(`/calls/${encodeURIComponent(status!.id)}/hangup`, "POST", { interrupted: true })
            .then((): Promise<void> => cache.invalidateQueries({ queryKey: ["private"] }))
            .catch((): void => {});
        }
      }
    }

    void refresh();

    return (): void => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [status?.id, status?.state, state, cache, dispose]);

  async function start(): Promise<void> {
    if (busy.current || !userId) {
      return;
    }

    busy.current = true;
    const generation = ++session.current.generation;
    session.current.transcript?.cancel();
    dispose();
    session.current.id = undefined;
    setState("connecting");
    setStatus(undefined);
    setTranscript([]);
    setTranscriptFailure(false);
    setNotice(undefined);
    setNotification(undefined);
    setMuted(false);
    setElapsedSeconds(0);
    let microphone = false;

    try {
      const audioContext = new AudioContext();
      session.current.audioContext = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      session.current.analyser = analyser;
      session.current.audioSamples = new Float32Array(analyser.fftSize);
      void audioContext.resume().catch((): void => {});
    } catch {
      // Audio analysis is optional; playback uses its own media element.
    }

    try {
      const configuration: { provider: string } = await (await requestApi("/live/configuration")).json();

      if (session.current.generation !== generation) {
        return;
      }

      if (configuration.provider === "stub") {
        void session.current.audioContext?.close().catch((): void => {});
        session.current.audioContext = undefined;
        session.current.analyser = undefined;
        session.current.audioSamples = undefined;
      }

      let offerSdp = "stub-offer";
      let peer: RTCPeerConnection | undefined;
      let channel: RTCDataChannel | undefined;

      if (configuration.provider !== "stub") {
        microphone = true;

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

        microphone = false;

        if (session.current.generation !== generation) {
          stream.getTracks().forEach((track): void => track.stop());
          return;
        }

        peer = new RTCPeerConnection();
        const audio = new Audio();
        audio.autoplay = true;
        Object.assign(session.current, { stream, peer, audio });

        peer.ontrack = (event): void => {
          if (
            session.current.generation !== generation ||
            session.current.peer !== peer ||
            event.track.kind !== "audio"
          ) {
            return;
          }

          const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
          audio.srcObject = remoteStream;

          const { audioContext, analyser } = session.current;

          if (audioContext && analyser) {
            try {
              session.current.audioSource?.disconnect();
              const source = audioContext.createMediaStreamSource(remoteStream);
              source.connect(analyser);
              session.current.audioSource = source;
            } catch {
              session.current.audioSource = undefined;
            }
          }

          void audio.play().catch((): void => {
            if (session.current.generation === generation && session.current.peer === peer) {
              setNotice("Audio playback was blocked. Allow sound for this site and retry the call.");
            }
          });
        };

        stream.getTracks().forEach((track): RTCRtpSender => peer!.addTrack(track, stream));
        channel = peer.createDataChannel("oai-events");
        await peer.setLocalDescription(await peer.createOffer());
        offerSdp = peer.localDescription!.sdp;
      }

      const connected = liveConnectionSchema.parse(
        await (
          await requestApi("/live/calls", "POST", {
            operationId: crypto.randomUUID(),
            offerSdp,
          })
        ).json(),
      );

      if (session.current.generation !== generation) {
        void requestApi(`/calls/${encodeURIComponent(connected.id)}/hangup`, "POST", {
          interrupted: true,
        }).catch((): void => {});

        return;
      }

      session.current.id = connected.id;

      session.current.transcript = createTranscriptSession(
        connected.id,
        channel,
        (entries): void => {
          if (session.current.generation === generation) {
            setTranscript(entries);
          }
        },
        (failure): void => {
          if (session.current.generation === generation) {
            setTranscriptFailure(failure);
          }
        },
      );

      if (peer) {
        peer.onconnectionstatechange = (): void => {
          if (peer?.connectionState === "failed") {
            void hangUp(true);
          } else if (peer?.connectionState === "connected") {
            setState("connected");
            session.current.transcript?.monitorChannel();

            void requestApi(`/calls/${encodeURIComponent(connected.id)}/connected`, "POST", {}).catch((): void => {
              if (session.current.generation === generation) {
                void hangUp(true);
              }
            });
          }
        };

        await peer.setRemoteDescription({
          type: "answer",
          sdp: connected.answerSdp,
        });
      }

      setStatus({
        id: connected.id,
        state: "connected",
        startedAt: new Date().toISOString(),
        endedAt: null,
        notice: null,
      });

      setState(peer ? "connecting" : "connected");

      if (connected.provider === "stub") {
        setNotice("Simulated voice provider. This isolated local scenario uses no paid requests.");
      }
    } catch (error) {
      if (session.current.generation !== generation) {
        return;
      }

      if (session.current.id) {
        void hangUp(true);
      }

      session.current.transcript?.cancel();
      dispose();
      setState("ready");
      setNotification(microphone ? "microphone" : "connection");
      setNotice(error instanceof Error ? error.message : "Could not start a call.");
    } finally {
      busy.current = false;
    }
  }

  function toggleMute(): void {
    const next = !muted;

    session.current.stream?.getAudioTracks().forEach((track): void => {
      track.enabled = !next;
    });

    setMuted(next);
  }

  function reset(): void {
    session.current.generation++;
    session.current.transcript?.cancel();
    dispose();
    session.current.id = undefined;
    setState("ready");
    setStatus(undefined);
    setTranscript([]);
    setTranscriptFailure(false);
    setNotice(undefined);
    setNotification(undefined);
    setElapsedSeconds(0);
  }

  return {
    state,
    status,
    transcript,
    transcriptFailure,
    retryTranscript: async (): Promise<void> => {
      await session.current.transcript?.complete();
    },
    notice: status?.notice ?? notice,
    notification,
    muted,
    elapsedSeconds,
    sampleAgentLevel,
    start,
    hangUp,
    toggleMute,
    reset,
    dismissNotification: (): void => setNotification(undefined),
  };
}
