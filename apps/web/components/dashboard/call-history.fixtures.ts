import type { CallRecord } from "./call-history";

const summitCall: CallRecord = {
  id: "summit-1042",
  date: "Nov 11 · 10:42",
  source: "Sample",
  carrier: "Summit Transport",
  load: "Dallas → Atlanta",
  outcome: "Agreement reached",
  agreements: "1",
  rate: "$2,450",
  sentiment: "Positive",
  analysis: "Complete",
};

export const calls: CallRecord[] = [
  summitCall,
  {
    id: "pine-ridge",
    date: "Nov 11 · 09:18",
    source: "Live",
    carrier: "Pine Ridge Haul",
    load: "Memphis → Denver",
    outcome: "No agreement",
    agreements: "0",
    rate: "—",
    sentiment: "Neutral",
    analysis: "Complete",
  },
  {
    id: "harbor",
    date: "Nov 10 · 16:05",
    source: "Sample",
    carrier: "Harbor Logistics",
    load: "Chicago → Detroit",
    outcome: "Agreement reached",
    agreements: "1",
    rate: "$1,180",
    sentiment: "Positive",
    analysis: "Complete",
  },
  {
    id: "cedar",
    date: "Nov 10 · 14:30",
    source: "Sample",
    carrier: "Cedar Transport",
    load: "No load selected",
    outcome: "Carrier ineligible",
    agreements: "0",
    rate: "—",
    sentiment: "Negative",
    analysis: "Complete",
  },
  {
    id: "mesa",
    date: "Nov 09 · 11:12",
    source: "Sample",
    carrier: "Mesa Freight",
    load: "Phoenix → Dallas",
    outcome: "Caller ended",
    agreements: "0",
    rate: "—",
    sentiment: "Neutral",
    analysis: "Pending",
  },
];

export const longCalls: CallRecord[] = [
  {
    ...summitCall,
    id: "long-carrier",
    carrier: "Summit Transport and Regional Distribution Partners",
    load: "San Bernardino, California → Jacksonville, Florida",
    analysis: "Failed",
  },
  ...calls.slice(1),
];
