import type { Meta, StoryObj } from "@storybook/react-vite";
import { renderSentimentDistribution as SentimentDistribution } from "./sentiment-distribution";
import { sentiments } from "./sentiment-distribution.fixtures";

const meta = {
  title: "Dashboard/SentimentDistribution",
  component: SentimentDistribution,
  args: { segments: sentiments, description: "20 calls · One rating per call" },
  decorators: [
    (Story) => (
      <div className="w-[900px] max-w-[calc(100vw-32px)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SentimentDistribution>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { segments: [], description: "0 calls" } };
