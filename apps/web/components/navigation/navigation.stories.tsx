import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Navigation } from "./navigation";

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
  args: {
    activePage: "dashboard",
    signedIn: true,
    accountName: "Local Reviewer",
  },
};

export const DeployedAdministrator: Story = {
  args: { signedIn: true, accountName: "admin@example.com", activePage: "dashboard" },
};

export const DeployedReviewer: Story = {
  args: { signedIn: true, accountName: "reviewer@example.com" },
};

export const AccountLoading: Story = { args: { accountLoading: true } };

export const Phone: Story = {
  globals: { viewport: { value: "xs", isRotated: false } },
};

export const Callbacks: Story = {
  play: async ({ canvasElement, args }): Promise<void> => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole("link", { name: "Dashboard" }));
    await expect(args.onNavigate).toHaveBeenLastCalledWith("dashboard");

    await userEvent.click(canvas.getByRole("link", { name: /^Call$/ }));
    await expect(args.onNavigate).toHaveBeenLastCalledWith("call");
    await expect(args.onNavigate).toHaveBeenCalledTimes(2);
    await expect(canvas.getByRole("link", { name: /^Call$/ })).toHaveAttribute("aria-current", "page");
  },
};
