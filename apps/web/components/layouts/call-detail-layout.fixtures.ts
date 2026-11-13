import type { CallDetail } from "./call-detail-layout";
import { firstLoad } from "@/components/dashboard/load-summary.fixtures";
import { loadOptions } from "@/components/dashboard/load-selector.fixtures";
import { transcriptEntries } from "@/components/call/transcript-fixtures";

// Callback implementations belong to stories; fixture content is deterministic.
export function createCallDetail(
  onLoadChange: (value: string | null) => void,
  onRetry: () => void,
): CallDetail {
  return {
    carrier: "Summit Transport",
    source: "Sample",
    dateAndDuration: "Nov 11, 2026 · 10:42 AM CST · 3m 08s",
    loadSummary: {
      outcome: "Agreement Reached",
      eligibility: "Carrier Eligible",
      carrier: "Summit Transport",
      mcNumber: "123456",
      selector: {
        options: loadOptions,
        value: "NS-1042",
        countLabel: "1 of 2",
        onValueChange: onLoadChange,
      },
      load: firstLoad,
    },
    analysis: {
      sentiment: "Positive",
      connection: "Ended normally",
      status: "complete",
      summary:
        "The carrier asked about NS-1042, negotiated the rate, and explicitly accepted $2,450.",
      onRetry,
    },
    transcript: transcriptEntries,
  };
}
