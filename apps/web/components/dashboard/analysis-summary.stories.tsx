import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderAnalysisSummary as AnalysisSummary } from "./analysis-summary";

const meta = {
  title: "Dashboard/AnalysisSummary",
  component: AnalysisSummary,
  args: {
    sentiment: "Positive",
    connection: "Ended normally",
    status: "complete",
    summary:
      "The carrier asked about NS-1042, negotiated the rate, and explicitly accepted $2,450.",
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div className="w-[838px] max-w-[calc(100vw-32px)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AnalysisSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Complete: Story = {};

export const Pending: Story = {
  args: { sentiment: "Unknown", status: "pending", summary: undefined },
};

export const Failed: Story = {
  args: { sentiment: "Unknown", status: "failed", summary: undefined },
};

export const AdministratorRetry: Story = {
  args: {
    sentiment: "Unknown",
    status: "failed",
    administrator: true,
    summary: undefined,
  },
};

export const LongContent: Story = {
  args: {
    summary:
      "The carrier reviewed the Dallas to Atlanta load, discussed pickup and delivery appointments, clarified the trailer and weight requirements, and negotiated a rate. After reviewing the posted quote and counteroffer, the carrier explicitly accepted $2,450. The final agreement was recorded for this simulated handoff. No additional load was accepted.",
  },
};
