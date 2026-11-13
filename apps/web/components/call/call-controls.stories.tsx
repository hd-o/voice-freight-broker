import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderCallControls as CallControls } from "./call-controls";

const meta = {
  title: "Call/Call Controls",
  component: CallControls,
  args: {
    state: "ready",
    onStart: fn(),
    onSignIn: fn(),
    onMute: fn(),
    onHangUp: fn(),
    onNewCall: fn(),
  },
} satisfies Meta<typeof CallControls>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {};

export const SignedIn: Story = { args: { signedIn: true } };

export const AccountPending: Story = { args: { accountPending: true } };

export const Connected: Story = {
  args: { state: "connected", signedIn: true },
};

export const Muted: Story = {
  args: { state: "connected", signedIn: true, muted: true },
};

export const Ended: Story = { args: { state: "ended", signedIn: true } };
