import { sampleCalls } from "@/lib/samples";
import { createCallDetail as createDetail } from "@/lib/reporting";

export function createCallDetail(onLoadChange: (value: string | null) => void, onRetry: () => void) {
  const detail = createDetail(sampleCalls[0], null, onLoadChange);

  return { ...detail, analysis: { ...detail.analysis, onRetry } };
}
