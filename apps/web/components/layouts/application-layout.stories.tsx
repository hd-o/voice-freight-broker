import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderPageHeader as PageHeader } from "@/components/navigation/page-header";
import { renderApplicationLayout as ApplicationLayout } from "./application-layout";

const meta = {
  title: "Layouts/Application",
  component: ApplicationLayout,
  parameters: { layout: "fullscreen" },
  args: {
    activePage: "call",
    signedIn: false,
    onNavigate: fn(),
    onAccountAction: fn(),
    children: <PageHeader title="Voice Freight Broker" subtitle="Talk to your AI freight broker." />,
  },
} satisfies Meta<typeof ApplicationLayout>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Call: Story = {};

export const Dashboard: Story = {
  args: {
    activePage: "dashboard",
    signedIn: true,
    children: <PageHeader title="Dashboard" subtitle="Review your calls and outcomes." />,
  },
};

export const Phone: Story = {
  globals: { viewport: { value: "xs", isRotated: false } },
};

export const Dark: Story = { globals: { theme: "dark" } };

export const LongContent: Story = {
  args: {
    children: (
      <>
        <PageHeader title="Voice Freight Broker" subtitle="Long content remains clear of the navigation." />
        <section
          aria-label="Example content"
          className="mt-8 flex min-h-[120vh] flex-col justify-between rounded-xl border border-border p-6"
        >
          <p>Start of content</p>
          <p>End of content</p>
        </section>
      </>
    ),
  },
};
