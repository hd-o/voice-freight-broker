import type { SentimentSegment } from "./sentiment-distribution";

export const sentiments: SentimentSegment[] = [
  { label: "Positive", count: 10, percentage: 50 },
  { label: "Neutral", count: 6, percentage: 30 },
  { label: "Negative", count: 2, percentage: 10 },
  { label: "Unknown", count: 2, percentage: 10 },
];
