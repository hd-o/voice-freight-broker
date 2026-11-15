import { expect, type Page } from "@playwright/test";
import type { TranscriptFragment } from "../packages/contracts/src/live";

type VoiceScenario = {
  fragments: TranscriptFragment[];
  failures: number;
  requests: number;
  polls: number;
  statusFailures: number;
};

export async function simulateVoice(page: Page, channelOpening = true): Promise<VoiceScenario> {
  const scenario: VoiceScenario = { fragments: [], failures: 0, requests: 0, polls: 0, statusFailures: 0 };
  let callState: "connected" | "ended" = "connected";

  await page.route("**/api/live/configuration", (route): Promise<void> =>
    route.fulfill({ json: { provider: "openai" } }),
  );

  await page.route("**/api/live/calls", (route): Promise<void> =>
    route.fulfill({ json: { id: "voice-test", answerSdp: "answer", provider: "openai" } }),
  );

  await page.route("**/api/calls/voice-test/connected", (route): Promise<void> => route.fulfill({ json: {} }));

  await page.route("**/api/calls/voice-test/hangup", async (route): Promise<void> => {
    callState = "ended";
    await route.fulfill({ json: {} });
  });

  await page.route("**/api/calls/voice-test/live", async (route): Promise<void> => {
    scenario.polls++;

    if (scenario.statusFailures > 0) {
      scenario.statusFailures--;
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    await route.fulfill({
      json: {
        id: "voice-test",
        state: callState,
        startedAt: new Date().toISOString(),
        endedAt: callState === "ended" ? new Date().toISOString() : null,
        notice: null,
      },
    });
  });

  await page.route("**/api/calls/voice-test/transcript", async (route): Promise<void> => {
    scenario.requests++;

    if (scenario.failures > 0) {
      scenario.failures--;
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    await route.fulfill({ json: { fragments: scenario.fragments } });
  });

  await page.addInitScript((opening): void => {
    class VoiceChannel extends EventTarget {
      readyState = "connecting";

      constructor() {
        super();

        window.addEventListener("voice-message", (event): void => {
          if (event instanceof CustomEvent) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event.detail) }));
          }
        });

        window.addEventListener("voice-close", (): void => {
          this.readyState = "closed";
          this.dispatchEvent(new Event("close"));
        });
      }
    }

    class VoicePeer {
      connectionState = "new";
      localDescription = { type: "offer", sdp: "offer" };
      onconnectionstatechange: (() => void) | null = null;
      channel = new VoiceChannel();

      createDataChannel(): VoiceChannel {
        return this.channel;
      }

      async createOffer(): Promise<{ type: string; sdp: string }> {
        return this.localDescription;
      }

      async setLocalDescription(): Promise<void> {}

      async setRemoteDescription(): Promise<void> {
        setTimeout((): void => {
          this.connectionState = "connected";
          this.onconnectionstatechange?.();

          if (opening) {
            this.channel.readyState = "open";
            this.channel.dispatchEvent(new Event("open"));
          }
        }, 0);
      }

      close(): void {
        this.channel.dispatchEvent(new Event("close"));
      }
    }

    Object.defineProperty(window, "RTCPeerConnection", { value: VoicePeer });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: async (): Promise<MediaStream> => new MediaStream() },
      configurable: true,
    });
  }, channelOpening);

  await page.goto("/call");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Local Reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Start call", exact: true }).click();
  await expect(page.getByText(/^Connected ·/)).toBeVisible();

  return scenario;
}

export async function sendTranscript(page: Page, text = "Live greeting.", eventId = "first"): Promise<void> {
  await page.evaluate(
    ({ text, eventId }): void => {
      window.dispatchEvent(
        new CustomEvent("voice-message", {
          detail: {
            type: "session.output_transcript.delta",
            event_id: eventId,
            delta: text,
            start_ms: 0,
            end_ms: 500,
          },
        }),
      );
    },
    { text, eventId },
  );
}
