import { sampleCalls } from "@/lib/samples";
import { createLoadDetails } from "@/lib/reporting";

export const firstLoad = createLoadDetails(
  sampleCalls[0],
  sampleCalls[0].loads[0],
);
export const secondLoad = createLoadDetails(
  sampleCalls[0],
  sampleCalls[0].loads[1],
);
