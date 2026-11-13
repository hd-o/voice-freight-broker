import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderPageHeader as PageHeader } from "./page-header";

const meta = {
  title: "Navigation/Page header",
  component: PageHeader,
  args: {
    title: "Voice Freight Broker",
    subtitle: "Talk to your AI freight broker.",
  },
  decorators: [
    (Story) => (
      <div className="w-[min(720px,calc(100vw-32px))]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PageHeader>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Call: Story = {};

export const Dashboard: Story = {
  args: { title: "Dashboard", subtitle: "Review your calls and outcomes." },
};

export const TitleOnly: Story = { args: { subtitle: undefined } };
