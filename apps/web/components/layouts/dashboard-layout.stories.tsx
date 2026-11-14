import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderDashboardLayout as DashboardLayout } from "./dashboard-layout";
import { metrics, emptyMetrics } from "@/components/dashboard/metric-card.fixtures";
import { sentiments } from "@/components/dashboard/sentiment-distribution.fixtures";
import { sampleCalls } from "@/lib/samples";
import { createCallHref } from "@/lib/navigation";
import { calls, longCalls } from "@/components/dashboard/call-history.fixtures";

const history = {
  rows: calls,
  pageLabel: `Showing 1–5 of ${sampleCalls.length} calls`,
  getCallHref: createCallHref,
  onNext: fn(),
  onPrevious: fn(),
};

const meta = {
  title: "Layouts/Dashboard",
  component: DashboardLayout,
  parameters: { layout: "fullscreen" },
  args: {
    signedIn: false,
    onNavigate: fn(),
    onAccountAction: fn(),
    metrics,
    sentiment: {
      segments: sentiments,
      description: `${sampleCalls.length} calls · One rating per call`,
    },
    history,
  },
} satisfies Meta<typeof DashboardLayout>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PublicSamples: Story = {};

export const SignedIn: Story = { args: { signedIn: true } };

export const Loading: Story = { args: { loading: true } };

export const Empty: Story = {
  args: {
    metrics: emptyMetrics,
    sentiment: { segments: [], description: "0 calls" },
    history: { ...history, rows: [], pageLabel: "0 calls" },
  },
};

export const LongContent: Story = {
  args: { history: { ...history, rows: longCalls } },
};
