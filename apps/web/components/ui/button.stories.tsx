import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderButton as Button } from "./button";

const meta = {
  title: "UI/Button",
  component: Button,
  args: { children: "Button" },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Outline: Story = { args: { variant: "outline" } };
export const Disabled: Story = { args: { disabled: true } };
export const CustomElement: Story = {
  args: { render: <div />, nativeButton: false },
};
