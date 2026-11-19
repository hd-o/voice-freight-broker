import { expect, type Page } from "@playwright/test";
import type { TranscriptFragment } from "../packages/contracts/src/live";

declare global {
  interface Window {
    voiceResources: {
      microphone: MediaStream;
      peerClosed: boolean;
      audioPaused: boolean;
      remoteGain?: GainNode;
      microphoneGain?: GainNode;
      remoteContext?: AudioContext;
      analysisContext?: AudioContext;
      orbScale?: number;
      orbFlow?: number;
    };
  }
}

type VoiceScenario = {
  state: "connected" | "ending" | "ended";
  fragments: TranscriptFragment[];
  failures: number;
  requests: number;
  cursors: number[];
  polls: number;
  statusFailures: number;
};

export async function simulateVoice(page: Page, channelOpening = true, remoteAudio = false): Promise<VoiceScenario> {
  const scenario: VoiceScenario = {
    state: "connected",
    fragments: [],
    failures: 0,
    requests: 0,
    cursors: [],
    polls: 0,
    statusFailures: 0,
  };

  await page.route("**/api/live/configuration", (route): Promise<void> =>
    route.fulfill({ json: { provider: "openai" } }),
  );

  await page.route("**/api/live/calls", (route): Promise<void> =>
    route.fulfill({ json: { id: "voice-test", answerSdp: "answer", provider: "openai" } }),
  );

  await page.route("**/api/calls/voice-test/connected", (route): Promise<void> => route.fulfill({ json: {} }));

  await page.route("**/api/calls/voice-test/hangup", async (route): Promise<void> => {
    scenario.state = "ended";
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
        state: scenario.state,
        startedAt: new Date().toISOString(),
        endedAt: scenario.state === "ended" ? new Date().toISOString() : null,
        notice: null,
      },
    });
  });

  await page.route(/\/api\/calls\/voice-test\/transcript(?:\?.*)?$/, async (route): Promise<void> => {
    scenario.requests++;

    if (scenario.failures > 0) {
      scenario.failures--;
      await route.fulfill({ status: 503, json: {} });

      return;
    }

    const after = new URL(route.request().url()).searchParams.get("after");

    if (after === null) {
      await route.fulfill({ json: { fragments: scenario.fragments } });
    } else {
      const cursor = Number(after);
      scenario.cursors.push(cursor);
      await route.fulfill({
        json: {
          fragments: scenario.fragments.slice(cursor + 1),
          cursor: Math.max(cursor, scenario.fragments.length - 1),
        },
      });
    }
  });

  await page.addInitScript(
    ({ opening, remote }): void => {
      const microphoneContext = new AudioContext();
      const microphoneDestination = microphoneContext.createMediaStreamDestination();
      window.voiceResources = {
        microphone: microphoneDestination.stream,
        peerClosed: false,
        audioPaused: false,
      };

      let remoteStream: MediaStream | undefined;

      if (remote) {
        const microphoneGain = microphoneContext.createGain();
        const microphoneOscillator = microphoneContext.createOscillator();
        microphoneGain.gain.value = 0;
        microphoneOscillator.connect(microphoneGain).connect(microphoneDestination);
        microphoneOscillator.start();
        window.voiceResources.microphoneGain = microphoneGain;
        const remoteContext = new AudioContext();
        const remoteGain = remoteContext.createGain();
        const oscillator = remoteContext.createOscillator();
        const destination = remoteContext.createMediaStreamDestination();
        remoteGain.gain.value = 0;
        oscillator.connect(remoteGain).connect(destination);
        oscillator.start();
        remoteStream = destination.stream;
        window.voiceResources.remoteContext = remoteContext;
        window.voiceResources.remoteGain = remoteGain;

        const createAnalyser: (this: AudioContext) => AnalyserNode = Reflect.get(
          AudioContext.prototype,
          "createAnalyser",
        );
        AudioContext.prototype.createAnalyser = function (): AnalyserNode {
          window.voiceResources.analysisContext = this;
          return createAnalyser.call(this);
        };

        const names = new WeakMap<WebGLUniformLocation, string>();
        const getLocation: typeof WebGLRenderingContext.prototype.getUniformLocation = Reflect.get(
          WebGLRenderingContext.prototype,
          "getUniformLocation",
        );
        const setUniform: typeof WebGLRenderingContext.prototype.uniform1f = Reflect.get(
          WebGLRenderingContext.prototype,
          "uniform1f",
        );
        WebGLRenderingContext.prototype.getUniformLocation = function (program, name): WebGLUniformLocation | null {
          const location = getLocation.call(this, program, name);

          if (location) {
            names.set(location, name);
          }

          return location;
        };
        WebGLRenderingContext.prototype.uniform1f = function (location, value): void {
          if (location && names.get(location) === "uScale") {
            window.voiceResources.orbScale = value;
          } else if (location && names.get(location) === "uFlow") {
            window.voiceResources.orbFlow = value;
          }

          setUniform.call(this, location, value);
        };
      }

      HTMLMediaElement.prototype.pause = (): void => {
        window.voiceResources.audioPaused = true;
      };

      class VoiceChannel extends EventTarget {
        readyState = "connecting";

        constructor() {
          super();

          window.addEventListener("voice-message", (event): void => {
            if (event instanceof CustomEvent) {
              this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event.detail) }));
            }
          });

          window.addEventListener("voice-open", (): void => {
            this.readyState = "open";
            this.dispatchEvent(new Event("open"));
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
        ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
        channel = new VoiceChannel();

        createDataChannel(): VoiceChannel {
          return this.channel;
        }

        addTrack(): void {}

        async createOffer(): Promise<{ type: string; sdp: string }> {
          return this.localDescription;
        }

        async setLocalDescription(): Promise<void> {}

        async setRemoteDescription(): Promise<void> {
          setTimeout((): void => {
            this.connectionState = "connected";
            this.onconnectionstatechange?.();

            if (remoteStream) {
              void microphoneContext.resume();
              void window.voiceResources.remoteContext?.resume();
              this.ontrack?.({ track: remoteStream.getAudioTracks()[0], streams: [remoteStream] });
            }

            if (opening) {
              this.channel.readyState = "open";
              this.channel.dispatchEvent(new Event("open"));
            }
          }, 0);
        }

        close(): void {
          window.voiceResources.peerClosed = true;
          this.channel.dispatchEvent(new Event("close"));
        }
      }

      Object.defineProperty(window, "RTCPeerConnection", { value: VoicePeer });

      Object.defineProperty(navigator, "mediaDevices", {
        value: { getUserMedia: async (): Promise<MediaStream> => window.voiceResources.microphone },
        configurable: true,
      });
    },
    { opening: channelOpening, remote: remoteAudio },
  );

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
