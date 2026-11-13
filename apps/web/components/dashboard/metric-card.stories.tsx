import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderMetricCard as MetricCard } from "./metric-card";
import { metrics, unavailableMetric } from "./metric-card.fixtures";

const meta = {
  title: "Dashboard/MetricCard",
  component: MetricCard,
  args: metrics[0],
  decorators: [
    (Story) => (
      <div className="w-[250px] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MetricCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Calls: Story = {};

export const AverageDuration: Story = { args: metrics[1] };

export const AgreementRate: Story = { args: metrics[2] };

export const FinalAgreements: Story = { args: metrics[3] };

export const RateVariance: Story = { args: metrics[4] };

export const Unavailable: Story = { args: unavailableMetric };
