import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderButton as Button } from "./button";
import {
  renderTooltip as Tooltip,
  renderTooltipContent as TooltipContent,
  renderTooltipProvider as TooltipProvider,
  renderTooltipTrigger as TooltipTrigger,
} from "./tooltip";

const meta = {
  title: "UI/Tooltip",
  component: TooltipContent,
  args: { children: "Helpful context", side: "top" },
  render: (args) => (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" />}>Hover or focus</TooltipTrigger>
        <TooltipContent {...args} />
      </Tooltip>
    </TooltipProvider>
  ),
} satisfies Meta<typeof TooltipContent>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Right: Story = { args: { side: "right" } };

export const Dark: Story = { globals: { theme: "dark" } };
