import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Phone, PhoneOff } from "lucide-react";
import { renderButton as Button } from "./button";

const meta = {
  title: "UI/Button",
  component: Button,
  args: { children: "Button", onClick: fn() },
} satisfies Meta<typeof Button>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Outline: Story = { args: { variant: "outline" } };

export const Disabled: Story = { args: { disabled: true } };

export const Secondary: Story = { args: { variant: "secondary" } };

export const Ghost: Story = { args: { variant: "ghost" } };

export const Destructive: Story = {
  args: {
    variant: "destructive",
    children: (
      <>
        <PhoneOff size={16} aria-hidden />
        End call
      </>
    ),
  },
};

export const Icon: Story = {
  args: {
    size: "icon",
    "aria-label": "Start call",
    children: <Phone size={20} aria-hidden />,
  },
};

export const Small: Story = { args: { size: "small" } };

export const CustomElement: Story = {
  args: { render: <div />, nativeButton: false },
};
