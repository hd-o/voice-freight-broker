import { WorkerEntrypoint } from "cloudflare:workers";
import { generateAnalysis } from "@voice-freight/backend/analysis-provider";
import type { AnalysisInput, AnalysisResponse } from "@voice-freight/backend/analysis";
import type { LiveBindings } from "./bindings";

// Private RPC keeps the existing provider credential in the API Worker. The
// Tools queue consumer owns claims, input selection, accounting and results.
export class AnalysisProvider extends WorkerEntrypoint<LiveBindings> {
  async generate(input: AnalysisInput, attemptId: string): Promise<AnalysisResponse> {
    return generateAnalysis(input, attemptId, this.env);
  }
}
