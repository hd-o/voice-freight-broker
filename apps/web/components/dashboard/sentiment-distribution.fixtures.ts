import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { sampleCalls } from "@/lib/samples";

export const sentiments = summarizeCalls(sampleCalls).sentiments;
