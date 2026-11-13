import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderPlaceholder as Placeholder } from "./placeholder";

const meta = {
  title: "Scaffold/Placeholder",
  component: Placeholder,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Placeholder>;

export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
