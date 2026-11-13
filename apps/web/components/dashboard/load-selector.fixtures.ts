import { sampleCalls } from "@/lib/samples";

export const loadOptions = sampleCalls[0].loads.map((load) => ({
  value: load.id,
  label: load.reference,
}));
