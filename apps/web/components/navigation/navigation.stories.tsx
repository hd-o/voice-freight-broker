import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
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
export const Callbacks: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Dashboard" }));
    await expect(args.onNavigate).toHaveBeenLastCalledWith("dashboard");
    await userEvent.click(canvas.getByRole("button", { name: /^Call$/ }));
    await expect(args.onNavigate).toHaveBeenLastCalledWith("call");
    await expect(args.onNavigate).toHaveBeenCalledTimes(2);
    await expect(
      canvas.getByRole("button", { name: /^Call$/ }),
    ).toHaveAttribute("aria-current", "page");
  },
};
