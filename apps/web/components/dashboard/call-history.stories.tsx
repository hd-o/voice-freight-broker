import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderCallHistory as CallHistory } from "./call-history";
import { calls, longCalls } from "./call-history.fixtures";
import { createCallHref } from "@/lib/navigation";
import { sampleCalls } from "@/lib/samples";

const meta = {
  title: "Dashboard/CallHistory",
  component: CallHistory,
  args: {
    rows: calls,
    pageLabel: `Showing 1–5 of ${sampleCalls.length} calls`,
    getCallHref: createCallHref,
    onNext: fn(),
    onPrevious: fn(),
  },
  decorators: [
    (Story): React.JSX.Element => (
      <div className="w-[1312px] max-w-[calc(100vw-32px)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CallHistory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { rows: [], pageLabel: "0 calls" } };

export const LastPage: Story = {
  args: {
    rows: calls.slice(0, 3),
    pageLabel: `Showing 6–8 of ${sampleCalls.length} calls`,
    previousVisible: true,
    nextDisabled: true,
  },
};

export const LongContent: Story = { args: { rows: longCalls } };
