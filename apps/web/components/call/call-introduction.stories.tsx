import type { Meta, StoryObj } from "@storybook/react-vite";
import { CallIntroduction } from "./call-introduction";

const meta = {
  title: "Call/Call Introduction",
  component: CallIntroduction,
  args: {
    className: "min-h-[490px] w-full max-w-[480px]",
  },
} satisfies Meta<typeof CallIntroduction>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
