import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderBadge as Badge } from "./badge";

const meta = {
  title: "UI/Badge",
  component: Badge,
  args: { children: "In progress" },
} satisfies Meta<typeof Badge>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Success: Story = {
  args: { variant: "success", children: "Booked" },
};

export const Warning: Story = {
  args: { variant: "warning", children: "Pending" },
};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Failed" },
};

export const Outline: Story = {
  args: { variant: "outline", children: "Dry van" },
};
