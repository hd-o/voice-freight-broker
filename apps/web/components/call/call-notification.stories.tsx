import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { CallNotification } from "./call-notification";

const meta = {
  title: "Call/Call Notification",
  component: CallNotification,
  args: { kind: "microphone", onDismiss: fn(), onAction: fn() },
} satisfies Meta<typeof CallNotification>;

export default meta;

type Story = StoryObj<typeof meta>;

export const MicrophoneBlocked: Story = { args: { kind: "microphone" } };

export const ConnectionFailure: Story = { args: { kind: "connection" } };

export const Interrupted: Story = { args: { kind: "interruption" } };

export const AnalysisFailure: Story = { args: { kind: "analysisFailure" } };

export const AdministratorAnalysisFailure: Story = {
  args: { kind: "analysisFailure", administrator: true },
};

export const DailyLimit: Story = { args: { kind: "dailyLimit" } };

export const Inactivity: Story = { args: { kind: "inactivity" } };
