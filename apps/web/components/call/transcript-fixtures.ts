import { sampleCalls } from "@/lib/samples";
import { createCallDetail } from "@/lib/reporting";

export const transcriptEntries = createCallDetail(
  sampleCalls[0],
  null,
  () => {},
).transcript;
