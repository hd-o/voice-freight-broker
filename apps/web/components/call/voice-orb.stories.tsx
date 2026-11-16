import type { Meta, StoryObj } from "@storybook/react-vite";
import { VoiceOrb } from "./voice-orb";

const meta = {
  title: "Call/Voice Orb",
  component: VoiceOrb,
  args: { connected: false },
} satisfies Meta<typeof VoiceOrb>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const Connected: Story = { args: { connected: true } };

export const Speaking: Story = {
  args: {
    connected: true,
    sampleAgentLevel: (): number => Math.max(0, Math.sin(performance.now() / 180) * 0.7),
  },
};
