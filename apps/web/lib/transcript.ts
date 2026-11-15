import {
  groupTranscript,
  transcriptEventSchema,
  transcriptSchema,
  type TranscriptFragment,
} from "@voice-freight/contracts/live";
import { requestApi } from "./account";

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
      const response = await requestApi(
        `/calls/${encodeURIComponent(callId)}/transcript`,
        "GET",
        undefined,
        requestController.signal,
      );
      const snapshot = transcriptSchema.parse(await response.json());

      if (cancellation || requestController.signal.aborted) {
        return;
      }

      // Saved fragments take precedence; retain events the backend has not saved yet.
      const identifiers = new Set(snapshot.fragments.map((entry): string => entry.id));
      fragments =
        mode === "replace"
          ? snapshot.fragments
          : [...snapshot.fragments, ...fragments.filter((entry): boolean => !identifiers.has(entry.id))];

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
    if (cancellation || suspension || fallback || typeof event.data !== "string") {
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

    if (fragments.some((entry): boolean => entry.id === fragmentId)) {
      return;
    }

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
  }

  function startPolling(): void {
    if (cancellation || suspension || fallback) {
      return;
    }

    fallback = true;
    clearTimeout(channelDeadline);
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
