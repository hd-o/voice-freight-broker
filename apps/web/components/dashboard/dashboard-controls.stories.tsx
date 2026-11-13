import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderDashboardControls as DashboardControls } from "./dashboard-controls";
const meta = {
  title: "Dashboard/Controls",
  component: DashboardControls,
  args: {
    administrator: false,
    accountName: "Local Reviewer",
    onRestock: fn(),
  },
} satisfies Meta<typeof DashboardControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Reviewer: Story = {};
export const Administrator: Story = {
  args: {
    administrator: true,
    accountName: "Local Administrator",
  },
};
export const Progress: Story = {
  args: { ...Administrator.args, restocking: true },
};
export const Success: Story = {
  args: {
    ...Administrator.args,
    feedback: "Added 20 loads. Existing calls keep their inventory.",
  },
};
export const Failure: Story = {
  args: {
    ...Administrator.args,
    feedback: "Restocking failed. Try again.",
    error: true,
  },
};
