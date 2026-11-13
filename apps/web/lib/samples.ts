import { callsSchema } from "@voice-freight/contracts/calls";
import records from "@/data/calls.json";

export const sampleCalls = callsSchema.parse(records);
