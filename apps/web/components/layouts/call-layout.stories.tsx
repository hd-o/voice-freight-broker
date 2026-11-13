import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderCallLayout as CallLayout } from "./call-layout";
import { demoCarriers } from "@/components/call/carrier-fixtures";
import { transcriptEntries } from "@/components/call/transcript-fixtures";

const meta = {
  title: "Layouts/Call",
  component: CallLayout,
  parameters: { layout: "fullscreen" },
  args: {
    state: "ready",
    signedIn: false,
    carriers: demoCarriers,
    entries: [],
    onNavigate: fn(),
    onAccountAction: fn(),
    onExploreSamples: fn(),
    onViewCall: fn(),
    onStart: fn(),
    onSignIn: fn(),
    onMute: fn(),
    onHangUp: fn(),
    onNewCall: fn(),
    onDismissNotification: fn(),
    onNotificationAction: fn(),
  },
} satisfies Meta<typeof CallLayout>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReadySignedOut: Story = {};
export const ReadySignedIn: Story = { args: { signedIn: true } };
export const Connected: Story = {
  args: {
    state: "connected",
    signedIn: true,
    duration: "02:18",
    entries: [
      {
        id: "load",
        speaker: "broker",
        label: "Northstar",
        time: "01:42",
        text: "I found NS-1042, Dallas to Atlanta. It’s a 53 ft dry van load.",
      },
      {
        id: "pickup",
        speaker: "carrier",
        label: "You",
        time: "01:52",
        text: "That works. What’s the pickup time?",
      },
      {
        id: "time",
        speaker: "broker",
        label: "Northstar",
        time: "02:03",
        text: "Pickup is tomorrow at 8:00 AM CST.",
      },
      {
        id: "rate",
        speaker: "carrier",
        label: "You",
        time: "02:13",
        text: "Thanks. Let’s talk about the rate.",
      },
    ],
  },
};
export const Muted: Story = { args: { ...Connected.args, muted: true } };
export const Ended: Story = {
  args: {
    state: "ended",
    signedIn: true,
    duration: "03:08",
    entries: transcriptEntries.slice(2),
    notification: "analysis",
  },
};
export const MicrophoneBlocked: Story = {
  args: { signedIn: true, notification: "microphone" },
};
export const ConnectionFailure: Story = {
  args: { signedIn: true, notification: "connection" },
};
export const Interrupted: Story = {
  args: { ...Ended.args, notification: "interruption" },
};
export const AnalysisFailure: Story = {
  args: { ...Ended.args, notification: "analysisFailure" },
};
export const DailyLimit: Story = {
  args: { signedIn: true, notification: "dailyLimit" },
};
export const Inactivity: Story = {
  args: { ...Connected.args, notification: "inactivity" },
};
export const LongTranscript: Story = {
  args: {
    ...Connected.args,
    entries: Array.from({ length: 5 }, (_, index) =>
      transcriptEntries.map((entry) => ({
        ...entry,
        id: `${index}-${entry.id}`,
      })),
    ).flat(),
  },
};
