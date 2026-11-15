import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { AccountPanel } from "./account-panel";
import { AlertDialog } from "@/components/ui/alert-dialog";

const meta = {
  title: "Navigation/Account Panel",
  component: AccountPanel,
  decorators: [
    (Story): React.JSX.Element => (
      <AlertDialog open>
        <Story />
      </AlertDialog>
    ),
  ],
  args: {
    identities: [
      { id: "reviewer", name: "Local Reviewer", role: "reviewer" },
      {
        id: "administrator",
        name: "Local Administrator",
        role: "administrator",
      },
    ],
    pending: false,
    onSignIn: fn(),
  },
} satisfies Meta<typeof AccountPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Accounts: Story = {};
export const Loading: Story = { args: { pending: true, identities: [] } };
export const Waiting: Story = {
  args: {
    pending: true,
    progress: "Another account change is finishing. Try again when it completes.",
  },
};
export const Failure: Story = {
  args: {
    error: "Local API unavailable. Start the local workers and try again.",
  },
};
