import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderSkeleton as Skeleton } from "./skeleton";

const meta = {
  title: "UI/Skeleton",
  component: Skeleton,
  args: { className: "h-5 w-48" },
} satisfies Meta<typeof Skeleton>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Text: Story = {};
export const Circle: Story = { args: { className: "size-12 rounded-full" } };
export const Card: Story = { args: { className: "h-32 w-72 rounded-xl" } };
