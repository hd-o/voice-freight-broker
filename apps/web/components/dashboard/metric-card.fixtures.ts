import type { MetricCardProps } from "./metric-card";

export const metrics: MetricCardProps[] = [
  { label: "Calls", value: "20", description: "20 active-session calls" },
  {
    label: "Avg. duration",
    value: "3m 12s",
    description: "20 completed calls",
  },
  {
    label: "Agreement rate",
    value: "75%",
    description: "9 of 12 matched calls",
  },
  {
    label: "Final agreements",
    value: "9",
    description: "Effective at call end",
  },
  {
    label: "Avg. rate variance",
    value: "+$125",
    description: "9 final agreements",
  },
];

export const unavailableMetric: MetricCardProps = {
  label: "Agreement rate",
  value: "Unavailable",
  description: "0 matched calls",
};

export const emptyMetrics: MetricCardProps[] = [
  { label: "Calls", value: "0", description: "No calls yet" },
  {
    label: "Avg. duration",
    value: "Unavailable",
    description: "0 completed calls",
  },
  unavailableMetric,
  { label: "Final agreements", value: "0", description: "No agreements yet" },
  {
    label: "Avg. rate variance",
    value: "Unavailable",
    description: "0 final agreements",
  },
];
