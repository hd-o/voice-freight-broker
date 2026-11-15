import type { Meta, StoryObj } from "@storybook/react-vite";
import { CallerBriefing } from "./caller-briefing";
import { demoCarriers } from "./carrier-fixtures";

const meta = {
  title: "Call/Caller Briefing",
  component: CallerBriefing,
  args: { carriers: demoCarriers, className: "w-full max-w-[392px]" },
} satisfies Meta<typeof CallerBriefing>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongCarrierName: Story = {
  args: {
    carriers: [
      {
        name: "North American Independent Carrier Transportation Cooperative",
        mcNumber: "123456",
      },
      ...demoCarriers.slice(1),
    ],
  },
};
