import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { LoadSummary } from "./load-summary";
import { firstLoad, secondLoad } from "./load-summary.fixtures";
import { loadOptions } from "./load-selector.fixtures";

const selector = {
  options: loadOptions,
  value: "NS-1042",
  countLabel: "1 of 2",
  onValueChange: fn(),
};

const meta = {
  title: "Dashboard/LoadSummary",
  component: LoadSummary,
  args: {
    outcome: "Agreement Reached",
    eligibility: "Carrier Eligible",
    carrier: "Summit Transport",
    source: "Live",
    dateAndDuration: "Nov 16, 2026, 06:56 PM UTC · 2m 46s",
    mcNumber: "123456",
    selector,
    load: firstLoad,
  },
  decorators: [
    (Story): React.JSX.Element => (
      <div className="w-[392px] max-w-[calc(100vw-32px)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoadSummary>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Agreement: Story = {};

export const SecondLoad: Story = {
  args: {
    load: secondLoad,
    selector: { ...selector, value: "NS-1048", countLabel: "2 of 2" },
  },
};

export const NoLoad: Story = {
  args: {
    outcome: "Carrier Ineligible",
    eligibility: "Carrier Ineligible",
    carrier: "Cedar Transport",
    mcNumber: "456789",
    load: null,
    selector: {
      ...selector,
      value: null,
      options: [],
      countLabel: "0 of 0",
      disabled: true,
    },
  },
};

export const LongContent: Story = {
  args: {
    carrier: "Summit Transport and Regional Distribution Partners",
    load: {
      ...firstLoad,
      route: "San Bernardino, California → Jacksonville, Florida",
      snapshot: [
        ...firstLoad.snapshot,
        "Appointment required · Check in at the east warehouse gate with the pickup reference.",
      ],
    },
  },
};
