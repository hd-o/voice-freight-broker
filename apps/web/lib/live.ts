"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  liveConnectionSchema,
  liveStatusSchema,
  type LiveStatus,
} from "@voice-freight/contracts/live";
import type { CallNotificationKind } from "@/components/call/call-notification";
import { requestApi } from "./account";

export function useLiveCall(userId?: string) {
  const cache = useQueryClient();
  const [state, setState] = useState<
    "ready" | "connecting" | "connected" | "ending" | "ended"
  >("ready");
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
    generation: number;
  }>({ generation: 0 });
  const busy = useRef(false);

  const dispose = useCallback(() => {
    const current = session.current;
    current.stream?.getTracks().forEach((track) => track.stop());
    if (current.peer) {
      current.peer.onconnectionstatechange = null;
      current.peer.close();
    }
    if (current.audio) {
      current.audio.pause();
      current.audio.srcObject = null;
    }
    current.peer = undefined;
    current.stream = undefined;
    current.audio = undefined;
  }, []);

  const hangUp = useCallback(
    async (interrupted = false) => {
      const id = session.current.id;
      if (!id) {
        session.current.generation++;
        busy.current = false;
        dispose();
        setState("ready");
        return;
      }
      setState("ending");
      session.current.stream?.getTracks().forEach((track) => {
        track.enabled = false;
      });
      try {
        await requestApi(`/calls/${encodeURIComponent(id)}/hangup`, "POST", {
          interrupted,
        });
        void cache.invalidateQueries({ queryKey: ["private"] });
      } catch (error) {
        dispose();
        setState("ended");
        setNotice(
          error instanceof Error
            ? error.message
            : "Could not finish the call. Your saved record remains available.",
        );
      }
    },
    [cache, dispose],
  );

  useEffect(() => {
    setState("ready");
    setStatus(undefined);
    setNotice(undefined);
    setNotification(undefined);
    setElapsedSeconds(0);
    function abandon() {
      const id = session.current.id;
      if (id)
        navigator.sendBeacon(
          `/api/calls/${encodeURIComponent(id)}/hangup`,
          new Blob([JSON.stringify({ interrupted: true })], {
            type: "application/json",
          }),
        );
      session.current.generation++;
      dispose();
      session.current.id = undefined;
    }
    window.addEventListener("pagehide", abandon);
    return () => {
      window.removeEventListener("pagehide", abandon);
      abandon();
    };
  }, [userId, dispose]);

  useEffect(() => {
    if (!status?.id || state === "ready") return;
    let active = true;
    let polling = false;
    async function refresh() {
      if (polling) return;
      polling = true;
      try {
        const result = liveStatusSchema.parse(
          await (
            await requestApi(`/calls/${encodeURIComponent(status!.id)}/live`)
          ).json(),
        );
        if (!active) return;
        setStatus(result);
        setState(
          result.state === "connected" &&
            session.current.peer &&
            session.current.peer.connectionState !== "connected"
            ? "connecting"
            : result.state,
        );
        setElapsedSeconds(
          Math.max(
            0,
            Math.floor(
              ((result.endedAt ? Date.parse(result.endedAt) : Date.now()) -
                Date.parse(result.startedAt)) /
                1000,
            ),
          ),
        );
        if (result.state === "ended") {
          window.clearInterval(timer);
          dispose();
          void cache.invalidateQueries({ queryKey: ["private"] });
          if (!result.notice) setNotification("analysis");
        }
      } catch (error) {
        if (active) {
          active = false;
          window.clearInterval(timer);
          dispose();
          setState("ended");
          setStatus((current) =>
            current ? { ...current, state: "ended", notice: null } : current,
          );
          setNotice(
            error instanceof Error ? error.message : "Call status unavailable.",
          );
          void requestApi(
            `/calls/${encodeURIComponent(status!.id)}/hangup`,
            "POST",
            { interrupted: true },
          )
            .then(() => cache.invalidateQueries({ queryKey: ["private"] }))
            .catch(() => {});
        }
      } finally {
        polling = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [status?.id, state === "ready", cache, dispose]);

  async function start() {
    if (busy.current || !userId) return;
    busy.current = true;
    const generation = ++session.current.generation;
    dispose();
    session.current.id = undefined;
    setState("connecting");
    setStatus(undefined);
    setNotice(undefined);
    setNotification(undefined);
    setMuted(false);
    setElapsedSeconds(0);
    let microphone = false;
    try {
      const configuration: { provider: string } = await (
        await requestApi("/live/configuration")
      ).json();
      let offerSdp = "stub-offer";
      let peer: RTCPeerConnection | undefined;
      if (configuration.provider !== "stub") {
        microphone = true;
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        microphone = false;
        if (session.current.generation !== generation) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        peer = new RTCPeerConnection();
        const audio = new Audio();
        audio.autoplay = true;
        session.current = { generation, stream, peer, audio };
        peer.ontrack = (event) => {
          audio.srcObject = event.streams[0];
          void audio
            .play()
            .catch(() =>
              setNotice(
                "Audio playback was blocked. Allow sound for this site and retry the call.",
              ),
            );
        };
        stream.getTracks().forEach((track) => peer!.addTrack(track, stream));
        peer.createDataChannel("oai-events");
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
        void requestApi(
          `/calls/${encodeURIComponent(connected.id)}/hangup`,
          "POST",
          { interrupted: true },
        ).catch(() => {});
        return;
      }
      session.current.id = connected.id;
      if (peer) {
        peer.onconnectionstatechange = () => {
          if (peer?.connectionState === "failed") void hangUp(true);
          else if (peer?.connectionState === "connected") {
            setState("connected");
            void requestApi(
              `/calls/${encodeURIComponent(connected.id)}/connected`,
              "POST",
              {},
            ).catch(() => {
              void hangUp(true);
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
        transcript: [],
      });
      setState(peer ? "connecting" : "connected");
      if (connected.provider === "stub")
        setNotice(
          "Simulated voice provider. This isolated local scenario uses no paid requests.",
        );
    } catch (error) {
      if (session.current.generation !== generation) return;
      if (session.current.id) void hangUp(true);
      dispose();
      setState("ready");
      setNotification(microphone ? "microphone" : "connection");
      setNotice(
        error instanceof Error ? error.message : "Could not start a call.",
      );
    } finally {
      busy.current = false;
    }
  }

  function toggleMute() {
    const next = !muted;
    session.current.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }

  function reset() {
    session.current.generation++;
    dispose();
    session.current.id = undefined;
    setState("ready");
    setStatus(undefined);
    setNotice(undefined);
    setNotification(undefined);
    setElapsedSeconds(0);
  }

  return {
    state,
    status,
    notice: status?.notice ?? notice,
    notification,
    muted,
    elapsedSeconds,
    start,
    hangUp,
    toggleMute,
    reset,
    dismissNotification: () => setNotification(undefined),
  };
}
