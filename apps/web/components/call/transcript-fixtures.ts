import type { TranscriptEntry } from "./transcript";

export const transcriptEntries: TranscriptEntry[] = [
  {
    id: "intro",
    speaker: "carrier",
    label: "Carrier",
    time: "00:12",
    text: "My MC number is 123456. I’m calling about NS-1042.",
  },
  {
    id: "quote",
    speaker: "broker",
    label: "Northstar",
    time: "01:28",
    text: "The posted rate is $2,300.",
  },
  {
    id: "offer",
    speaker: "carrier",
    label: "Carrier",
    time: "01:41",
    text: "Could you do $2,600?",
  },
  {
    id: "counter",
    speaker: "broker",
    label: "Northstar",
    time: "02:18",
    text: "I can offer $2,450. Does that work for you?",
  },
  {
    id: "acceptance",
    speaker: "carrier",
    label: "Carrier",
    time: "02:30",
    text: "Yes, I accept $2,450.",
  },
  {
    id: "handoff",
    speaker: "broker",
    label: "Northstar",
    time: "02:35",
    text: "Your agreement is saved. This handoff is simulated.",
  },
];
