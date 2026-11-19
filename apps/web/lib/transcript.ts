import {
  groupTranscript,
  transcriptEventSchema,
  transcriptSchema,
  type TranscriptFragment,
} from "@voice-freight/contracts/live";
import { z } from "zod";
import { requestApi } from "./account";

const transcriptPageSchema = transcriptSchema.extend({ cursor: z.number().int().min(-1).optional() });

export type TranscriptSession = {
  monitorChannel: () => void;
  complete: () => Promise<void>;
  suspend: () => void;
  cancel: () => void;
};

export function createTranscriptSession(
  callId: string,
  channel: RTCDataChannel | undefined,
  updateTranscript: (entries: TranscriptFragment[]) => void,
  updateTranscriptFailure: (failure: boolean) => void,
): TranscriptSession {
  let fragments: TranscriptFragment[] = [];
  let cancellation = false;
  let suspension = false;
  let fallback = false;
  let cursor = -1;
  let identifiers = new Set<string>();
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  let channelDeadline: ReturnType<typeof setTimeout> | undefined;
  let pendingRequest: AbortController | undefined;

  function publishTranscript(): void {
    fragments.sort((a, b): number => a.startMs - b.startMs || a.endMs - b.endMs);
    updateTranscript(groupTranscript(fragments));
  }

  async function refreshTranscript(mode: "merge" | "replace" = "merge"): Promise<void> {
    if (cancellation || pendingRequest) {
      return;
    }

    const requestController = new AbortController();
    pendingRequest = requestController;

    try {
      const path = `/calls/${encodeURIComponent(callId)}/transcript`;
      const response = await requestApi(
        mode === "replace" ? path : `${path}?after=${cursor}`,
        "GET",
        undefined,
        requestController.signal,
      );

      const snapshot = transcriptPageSchema.parse(await response.json());

      if (cancellation || requestController.signal.aborted) {
        return;
      }

      if (mode === "replace") {
        fragments = snapshot.fragments;
        identifiers = new Set(fragments.map((entry): string => entry.id));
      } else {
        const saved = new Map(snapshot.fragments.map((entry): [string, TranscriptFragment] => [entry.id, entry]));
        fragments = fragments.map((entry): TranscriptFragment => saved.get(entry.id) ?? entry);

        for (const entry of snapshot.fragments) {
          if (!identifiers.has(entry.id)) {
            fragments.push(entry);
            identifiers.add(entry.id);
          }
        }

        cursor = snapshot.cursor ?? cursor;
      }

      publishTranscript();
      updateTranscriptFailure(false);
    } catch {
      if (!cancellation && !requestController.signal.aborted && mode === "replace") {
        updateTranscriptFailure(true);
      }
    } finally {
      if (pendingRequest === requestController) {
        pendingRequest = undefined;
      }
    }
  }

  function receiveTranscript(event: MessageEvent): void {
    if (cancellation || suspension || typeof event.data !== "string") {
      return;
    }

    let input: unknown;

    try {
      input = JSON.parse(event.data);
    } catch {
      return;
    }

    const transcriptEvent = transcriptEventSchema.safeParse(input);

    if (!transcriptEvent.success || !transcriptEvent.data.delta) {
      return;
    }

    const fragmentId = `${callId}:${transcriptEvent.data.event_id}`;

    if (identifiers.has(fragmentId)) {
      return;
    }

    identifiers.add(fragmentId);
    fragments.push({
      id: fragmentId,
      speaker: transcriptEvent.data.type === "session.input_transcript.delta" ? "carrier" : "broker",
      startMs: transcriptEvent.data.start_ms,
      endMs: transcriptEvent.data.end_ms,
      text: transcriptEvent.data.delta,
    });

    publishTranscript();
  }

  function clearChannelDeadline(): void {
    clearTimeout(channelDeadline);
    channelDeadline = undefined;

    if (fallback && !cancellation && !suspension) {
      clearInterval(pollingTimer);
      void refreshTranscript();
      // Sideband persistence can lag behind channel recovery, so continue
      // reconciling missed events while receiving new channel messages.
      pollingTimer = setInterval((): void => {
        void refreshTranscript();
      }, 5000);
    }
  }

  function startPolling(): void {
    if (cancellation || suspension) {
      return;
    }

    fallback = true;
    clearTimeout(channelDeadline);
    clearInterval(pollingTimer);
    void refreshTranscript();

    pollingTimer = setInterval((): void => {
      void refreshTranscript();
    }, 1000);
  }

  function stopUpdates(): void {
    clearTimeout(channelDeadline);
    clearInterval(pollingTimer);
    channel?.removeEventListener("message", receiveTranscript);
    channel?.removeEventListener("open", clearChannelDeadline);
    channel?.removeEventListener("close", startPolling);
    channel?.removeEventListener("error", startPolling);
    pendingRequest?.abort();
    pendingRequest = undefined;
  }

  if (channel) {
    channel.addEventListener("message", receiveTranscript);
    channel.addEventListener("open", clearChannelDeadline);
    channel.addEventListener("close", startPolling);
    channel.addEventListener("error", startPolling);
  } else {
    startPolling();
  }

  return {
    monitorChannel(): void {
      if (!cancellation && !suspension && !fallback && channel?.readyState !== "open" && !channelDeadline) {
        channelDeadline = setTimeout(startPolling, 5000);
      }
    },
    async complete(): Promise<void> {
      suspension = true;
      stopUpdates();
      await refreshTranscript("replace");
    },
    suspend(): void {
      suspension = true;
      stopUpdates();
    },
    cancel(): void {
      cancellation = true;
      stopUpdates();
    },
  };
}
