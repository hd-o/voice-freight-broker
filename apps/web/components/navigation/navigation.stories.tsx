import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderNavigation as Navigation } from "./navigation";

const meta = {
  title: "Navigation/Navigation",
  component: Navigation,
  parameters: { layout: "fullscreen" },
  args: {
    activePage: "call",
    signedIn: false,
    onNavigate: fn(),
    onAccountAction: fn(),
  },
} satisfies Meta<typeof Navigation>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Call: Story = {};
export const Dashboard: Story = {
  args: { activePage: "dashboard", signedIn: true },
};
export const Phone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
};
