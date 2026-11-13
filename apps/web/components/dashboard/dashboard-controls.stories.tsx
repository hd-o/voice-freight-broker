import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderDashboardControls as DashboardControls } from "./dashboard-controls";
const meta = {
  title: "Dashboard/Controls",
  component: DashboardControls,
  args: {
    onRestock: fn(),
  },
} satisfies Meta<typeof DashboardControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Administrator: Story = {};
export const Progress: Story = {
  args: { restocking: true },
};
export const Success: Story = {
  args: {
    feedback: "Added 20 loads. Existing calls keep their inventory.",
  },
};
export const Failure: Story = {
  args: {
    feedback: "Restocking failed. Try again.",
    error: true,
  },
};
