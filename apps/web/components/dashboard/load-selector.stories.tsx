import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { LoadSelector } from "./load-selector";
import { loadOptions } from "./load-selector.fixtures";

const meta = {
  title: "Dashboard/LoadSelector",
  component: LoadSelector,
  args: {
    options: loadOptions,
    value: "NS-1042",
    countLabel: "1 of 2",
    onValueChange: fn(),
    onOpenChange: fn(),
  },
  decorators: [
    (Story): React.JSX.Element => (
      <div className="w-[342px] max-w-[calc(100vw-32px)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LoadSelector>;

export default meta;

type Story = StoryObj<typeof meta>;

export const FirstLoad: Story = {};

export const SecondLoad: Story = {
  args: { value: "NS-1048", countLabel: "2 of 2" },
};

export const Options: Story = { args: { open: true } };

export const SecondOptionSelected: Story = {
  args: { open: true, value: "NS-1048", countLabel: "2 of 2" },
};

export const Empty: Story = {
  args: { value: null, options: [], countLabel: "0 of 0", disabled: true },
};
