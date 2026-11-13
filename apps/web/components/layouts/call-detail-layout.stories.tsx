import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { renderCallDetailLayout as CallDetailLayout } from "./call-detail-layout";
import { createCallDetail } from "./call-detail-layout.fixtures";
import { secondLoad } from "@/components/dashboard/load-summary.fixtures";
const record = createCallDetail(fn(), fn());
const meta = {
  title: "Layouts/CallDetail",
  component: CallDetailLayout,
  parameters: { layout: "fullscreen" },
  args: { signedIn: true, onNavigate: fn(), onAccountAction: fn(), record },
} satisfies Meta<typeof CallDetailLayout>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { args: { loading: true, record: null } };
export const Empty: Story = { args: { record: null } };
export const AnalysisPending: Story = {
  args: {
    record: {
      ...record,
      analysis: {
        ...record.analysis,
        sentiment: "Unknown",
        status: "pending",
        summary: undefined,
      },
    },
  },
};
export const AnalysisFailed: Story = {
  args: {
    record: {
      ...record,
      analysis: {
        ...record.analysis,
        sentiment: "Unknown",
        status: "failed",
        summary: undefined,
      },
    },
  },
};
export const AdministratorRetry: Story = {
  args: {
    record: {
      ...record,
      analysis: {
        ...record.analysis,
        sentiment: "Unknown",
        status: "failed",
        summary: undefined,
        administrator: true,
      },
    },
  },
};
export const SecondLoad: Story = {
  args: {
    record: {
      ...record,
      loadSummary: {
        ...record.loadSummary,
        load: secondLoad,
        selector: {
          ...record.loadSummary.selector,
          value: "NS-1048",
          countLabel: "2 of 2",
        },
      },
    },
  },
};
export const EmptyTranscript: Story = {
  args: { record: { ...record, transcript: [] } },
};
export const LongContent: Story = {
  args: {
    record: {
      ...record,
      carrier: "Summit Transport and Regional Distribution Partners",
      loadSummary: {
        ...record.loadSummary,
        carrier: "Summit Transport and Regional Distribution Partners",
      },
      transcript: record.transcript.map((entry) => ({
        ...entry,
        text: `${entry.text} We also discussed the pickup appointment, delivery requirements, trailer dimensions, and the contact information for the receiving warehouse. Please confirm the details before proceeding with the simulated handoff.`,
      })),
    },
  },
};
