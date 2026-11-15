import type { Meta, StoryObj } from "@storybook/react-vite";
import { Transcript } from "./transcript";
import { transcriptEntries } from "./transcript-fixtures";

const meta = {
  title: "Call/Transcript",
  component: Transcript,
  args: {
    entries: transcriptEntries,
    className: "w-full max-w-3xl max-h-[550px]",
  },
} satisfies Meta<typeof Transcript>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Conversation: Story = {};

export const Empty: Story = { args: { entries: [] } };

export const LongConversation: Story = {
  args: {
    entries: Array.from({ length: 5 }, (_, index): typeof transcriptEntries =>
      transcriptEntries.map((entry): (typeof transcriptEntries)[number] => ({
        ...entry,
        id: `${index}-${entry.id}`,
      })),
    ).flat(),
  },
};

export const LongMessage: Story = {
  args: {
    entries: transcriptEntries.slice(0, 1).map((entry): (typeof transcriptEntries)[number] => ({
      ...entry,
      text: "Could you confirm the pickup window and the delivery appointment? I need to coordinate with my dispatcher before accepting this load. Please include any loading requirements and the shipper’s contact details.",
    })),
  },
};
