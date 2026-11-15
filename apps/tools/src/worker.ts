import { WorkerEntrypoint } from "cloudflare:workers";
import { checkDatabase } from "@voice-freight/backend";
import { statusSchema } from "@voice-freight/contracts";
import {
  callContextSchema,
  evidenceSchema,
  type CallContext,
  type ToolName,
  type EvidenceInput,
} from "@voice-freight/contracts/business";
import { executeTool, type ToolResult } from "@voice-freight/backend/business";
import { recordEvidence } from "@voice-freight/backend/evidence";
import { BusinessError } from "@voice-freight/backend/model";

type ToolResponse = ToolResult | { error: { code: string; message: string } };

export class Tools extends WorkerEntrypoint<Env> {
  async executeObserved(
    context: CallContext,
    name: ToolName,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    try {
      return await executeTool(
        this.env.DB,
        callContextSchema.parse(context),
        name,
        invocation,
        new Date().toISOString(),
        true,
      );
    } catch (error) {
      if (error instanceof BusinessError) {
        return { error: { code: error.code, message: error.message } };
      }
      return {
        error: {
          code: "unavailable",
          message: "Tool execution is unavailable. Ask the caller to retry.",
        },
      };
    }
  }

  async execute(
    context: CallContext,
    name: ToolName,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    try {
      return await executeTool(this.env.DB, callContextSchema.parse(context), name, invocation);
    } catch (error) {
      if (error instanceof BusinessError) {
        return { error: { code: error.code, message: error.message } };
      }
      if (error instanceof Error && error.name === "ZodError") {
        return {
          error: {
            code: "invalid_input",
            message: "Request validation failed.",
          },
        };
      }
      return {
        error: {
          code: "unavailable",
          message: "Service unavailable. Check local migrations and retry.",
        },
      };
    }
  }

  async recordEvidence(context: CallContext, evidence: EvidenceInput): ReturnType<typeof recordEvidence> {
    return recordEvidence(this.env.DB, callContextSchema.parse(context), evidenceSchema.parse(evidence));
  }

  async verify_carrier(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "verify_carrier", invocation);
  }
  async search_loads(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "search_loads", invocation);
  }
  async select_load(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "select_load", invocation);
  }
  async evaluate_offer(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "evaluate_offer", invocation);
  }
  async begin_renegotiation(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "begin_renegotiation", invocation);
  }
  async confirm_handoff(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "confirm_handoff", invocation);
  }
  async cancel_agreement(
    context: CallContext,
    invocation: { invocationId: string; arguments: unknown },
  ): Promise<ToolResponse> {
    return this.execute(context, "cancel_agreement", invocation);
  }

  async getStatus(): Promise<ReturnType<typeof statusSchema.parse>> {
    return statusSchema.parse({
      service: "tools",
      database: await checkDatabase(this.env.DB),
    });
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
