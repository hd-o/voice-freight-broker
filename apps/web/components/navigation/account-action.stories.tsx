import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderAccountAction as AccountAction } from "./account-action";

const meta = {
  title: "Navigation/Account action",
  component: AccountAction,
  args: { signedIn: false, onAccountAction: fn() },
} satisfies Meta<typeof AccountAction>;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedOut: Story = {};
export const SignedIn: Story = { args: { signedIn: true } };
