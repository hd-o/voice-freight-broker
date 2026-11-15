import { sampleCalls } from "@/lib/samples";

export const loadOptions = sampleCalls[0].loads.map((load): { value: string; label: string } => ({
  value: load.id,
  label: load.reference,
}));
