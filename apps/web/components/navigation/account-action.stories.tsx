import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { renderAccountAction as AccountAction } from "./account-action";
import { renderTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";

const meta = {
  title: "Navigation/Account action",
  component: AccountAction,
  args: { signedIn: false, onAccountAction: fn() },
  decorators: [
    (Story) => (
      <TooltipProvider>
        <Story />
      </TooltipProvider>
    ),
  ],
} satisfies Meta<typeof AccountAction>;

export default meta;

type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {};

export const SignedIn: Story = { args: { signedIn: true } };

export const Pending: Story = { args: { pending: true } };

export const Callback: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Sign in" }),
    );

    await expect(args.onAccountAction).toHaveBeenCalledOnce();
  },
};
