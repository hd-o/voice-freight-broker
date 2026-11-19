import {
  processAnalysis,
  dispatchAnalysis,
  analysisJobSchema,
  type AnalysisJob,
} from "@voice-freight/backend/analysis";
import { observeOperation } from "@voice-freight/backend/telemetry";
import type { ConfirmationProvider } from "../../api/src/confirmation-provider";
import type { AnalysisProvider } from "../../api/src/analysis-provider";
import type { LiveCall } from "../../api/src/live-call";
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

interface ToolsBindings {
  DB: D1Database;
  CALLS: DurableObjectNamespace<LiveCall>;
  ANALYSIS_QUEUE: Queue<AnalysisJob>;
  ANALYSIS_DEAD_LETTER: Queue<AnalysisJob>;
  ANALYSIS_PROVIDER: Service<AnalysisProvider>;
  CONFIRMATION_PROVIDER: Service<ConfirmationProvider>;
}

type ToolResponse = ToolResult | { error: { code: string; message: string } };

export class Tools extends WorkerEntrypoint<ToolsBindings> {
  protected resolveClock(): string {
    return new Date().toISOString();
  }

  async dispatchAnalysis(job: AnalysisJob): Promise<number | null> {
    return dispatchAnalysis(this.env.DB, this.env.ANALYSIS_QUEUE, analysisJobSchema.parse(job));
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
        this.resolveClock(),
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
  async queue(batch: MessageBatch<unknown>, env: ToolsBindings, context: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const parsed = analysisJobSchema.safeParse(message.body);

      if (!parsed.success) {
        message.ack();
        continue;
      }
      const job = parsed.data;

      if (batch.queue.endsWith("analysis-dead-letter")) {
        // The coordinator can republish the job after a transport failure.
        // A delayed dead letter carries no proof about the current attempt.
        await observeOperation(
          { callId: job.callId, version: job.version, function: "analysis", action: "dead-letter" },
          async () => {},
        );
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

        // Wake promptly for retries, renewals, and cleanup. The published
        // job still has a durable watchdog if this notification is lost.
        context.waitUntil(
          env.CALLS.get(env.CALLS.idFromName(job.callId))
            .refreshAnalysis(job)
            .catch((): void => {}),
        );

        if (disposition === "dead-letter") {
          await env.ANALYSIS_DEAD_LETTER.send(job);
        }
        message.ack();
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<ToolsBindings>;
