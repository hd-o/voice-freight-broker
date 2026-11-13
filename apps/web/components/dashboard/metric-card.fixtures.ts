import { sampleCalls } from "@/lib/samples";
import { createMetrics } from "@/lib/reporting";

export const metrics = createMetrics(sampleCalls);
export const emptyMetrics = createMetrics([]);
export const unavailableMetric = emptyMetrics[2];
