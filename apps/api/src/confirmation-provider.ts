import { WorkerEntrypoint } from "cloudflare:workers";
import { classifyConfirmation } from "@voice-freight/backend/confirmation-provider";
import type { ConfirmationInput, ConfirmationOutcome } from "@voice-freight/backend/confirmation-policy";
import type { LiveBindings } from "./bindings";

// Only the API Worker holds the credential; Tools owns attempts and accounting.
export class ConfirmationProvider extends WorkerEntrypoint<LiveBindings> {
  async classify(input: ConfirmationInput, attemptId: string): Promise<ConfirmationOutcome> {
    return classifyConfirmation(input, attemptId, this.env);
  }
}
