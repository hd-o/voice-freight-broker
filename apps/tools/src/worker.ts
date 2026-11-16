import {
  processAnalysis,
  publishAnalysis,
  recordDeadLetter,
  analysisJobSchema,
  type AnalysisJob,
} from "@voice-freight/backend/analysis";
import { observeOperation } from "@voice-freight/backend/telemetry";
import type { ConfirmationProvider } from "../../api/src/confirmation-provider";
import type { AnalysisProvider } from "../../api/src/analysis-provider";
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

interface AnalysisBindings {
  DB: D1Database;
  ANALYSIS_QUEUE: Queue<AnalysisJob>;
  ANALYSIS_DEAD_LETTER: Queue<AnalysisJob>;
  ANALYSIS_PROVIDER: Service<AnalysisProvider>;
  CONFIRMATION_PROVIDER: Service<ConfirmationProvider>;
}

type ToolResponse = ToolResult | { error: { code: string; message: string } };

export class Tools extends WorkerEntrypoint<Env & AnalysisBindings> {
  async publishAnalysis(): Promise<void> {
    return publishAnalysis(this.env.DB, this.env.ANALYSIS_QUEUE);
  }

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
        (input, attemptId) => this.env.CONFIRMATION_PROVIDER.classify(input, attemptId),
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
  async scheduled(_controller: ScheduledController, env: Env & AnalysisBindings): Promise<void> {
    await publishAnalysis(env.DB, env.ANALYSIS_QUEUE);
  },
  async queue(batch: MessageBatch<unknown>, env: Env & AnalysisBindings): Promise<void> {
    for (const message of batch.messages) {
      const parsed = analysisJobSchema.safeParse(message.body);

      if (!parsed.success) {
        message.ack();
        continue;
      }
      const job = parsed.data;

      if (batch.queue.endsWith("analysis-dead-letter")) {
        await recordDeadLetter(env.DB, job);
        message.ack();
        continue;
      }

      try {
        const disposition = await observeOperation(
          { callId: job.callId, jobId: `${job.callId}:v${job.version}`, function: "analysis" },
          () =>
            processAnalysis(env.DB, job, (input, attemptId) =>
              observeOperation(
                {
                  callId: job.callId,
                  jobId: attemptId,
                  function: "analysis",
                  attempt: Number(attemptId.split(":a").at(-1)),
                },
                () => env.ANALYSIS_PROVIDER.generate(input, attemptId),
              ),
            ),
        );

        if (disposition === "retry") {
          message.retry({ delaySeconds: 30 });
        } else {
          if (disposition === "dead-letter") {
            await env.ANALYSIS_DEAD_LETTER.send(job);
          }
          message.ack();
        }
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env & AnalysisBindings>;
