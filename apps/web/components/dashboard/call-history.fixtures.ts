import type { CallRecord } from "./call-history";
import { sampleCalls } from "@/lib/samples";
import { createHistory } from "@/lib/reporting";

export const calls = createHistory(sampleCalls).slice(0, 5);

export const longCalls: CallRecord[] = calls.map((call, index): CallRecord =>
  index === 0
    ? {
        ...call,
        carrier: "Summit Transport and Regional Distribution Partners",
        load: "San Bernardino, California → Jacksonville, Florida",
      }
    : call,
);
