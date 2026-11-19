import { confirmationQuietMs } from "@voice-freight/backend/confirmation-policy";
import { observeOperation } from "@voice-freight/backend/telemetry";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { finalizationSchema, toolNameSchema, type CallContext } from "@voice-freight/contracts/business";
import type { Call } from "@voice-freight/contracts/calls";
import { createReadback } from "@voice-freight/backend/readbacks";
import { completeCall, finalizeCall } from "@voice-freight/backend/calls";
import { findPendingAnalysis, retryAnalysis, type AnalysisJob } from "@voice-freight/backend/analysis";
import { findLiveSession, reserveLiveCall } from "@voice-freight/backend/live";
import { ingestProviderEvent, providerEventSchema } from "@voice-freight/backend/provider-events";
import { BusinessError, requireCondition } from "@voice-freight/backend/model";
import { readState, transact } from "@voice-freight/backend/repository";
import {
  calculateAvailableMicrodollars,
  maximumContinuationCount,
  maximumResponseCount,
  resolveUsageLimits,
  shutdownHeadroomMicrodollars,
} from "@voice-freight/backend/spending";
import { createSessionConfiguration, greeting, voiceToolArguments, voiceToolNameSchema } from "./live-configuration";
import { projectVoiceResult } from "./voice-results";
import type { LiveBindings } from "./bindings";

const sessionResponseSchema = z.object({
  session: z.object({ id: z.string() }),
  transport: z.object({ sdp: z.string() }),
});
const functionEventSchema = z.object({
  delegation_id: z.string(),
  event: z.object({
    type: z.literal("response.output_item.done"),
    item: z.object({
      type: z.literal("function_call"),
      call_id: z.string(),
      name: voiceToolNameSchema,
      arguments: z.string(),
    }),
  }),
});

const startupTimeout = 30_000;
const recoveryDelay = 30_000;
const closureRetryInterval = 300_000;

type AnalysisCommand = { context: CallContext } & (
  | { action: "finalize"; input: z.infer<typeof finalizationSchema>; completedAt: string }
  | { action: "retry"; version: number }
);

type CallWork = {
  live?: number;
  analysis?: AnalysisJob & { due?: number };
  command?: { input: AnalysisCommand; due: number };
};

type CallOutcome<T> = { result: T } | { error: Pick<BusinessError, "code" | "message" | "status"> };

async function captureOutcome<T>(command: () => Promise<T>): Promise<CallOutcome<T>> {
  try {
    return { result: await command() };
  } catch (error) {
    if (error instanceof BusinessError) {
      return { error: { code: error.code, message: error.message, status: error.status } };
    }

    return {
      error: { code: "unavailable", message: "Service unavailable. Check local migrations and retry.", status: 503 },
    };
  }
}

export class LiveCall extends DurableObject<LiveBindings> {
  private socket: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private context: CallContext | null = null;
  private closing = false;
  private invocations = new Set<string>();

  private async updateWork<T>(command: (work: CallWork) => T): Promise<T> {
    return this.ctx.storage.transaction(async (storage): Promise<T> => {
      const work = (await storage.get<CallWork>("work")) ?? {};
      const result = command(work);
      const deadlines = [work.live, work.analysis?.due, work.command?.due].filter(
        (due): due is number => due !== undefined,
      );

      if (deadlines.length) {
        await storage.put("work", work);
        await storage.setAlarm(Math.min(...deadlines));
      } else {
        await storage.delete("work");
        await storage.deleteAlarm();
      }

      return result;
    });
  }

  private async scheduleLive(due: number | null): Promise<void> {
    await this.updateWork((work): void => {
      if (due === null) {
        delete work.live;
      } else {
        work.live = due;
      }
    });
  }

  private async stageAnalysis(job: AnalysisJob): Promise<void> {
    await this.updateWork((work): void => {
      if (!work.analysis || work.analysis.version < job.version) {
        work.analysis = job;
      }
    });
  }

  async refreshAnalysis(job: AnalysisJob): Promise<void> {
    await this.updateWork((work): void => {
      if (
        work.analysis?.callId === job.callId &&
        work.analysis.version === job.version &&
        work.analysis.due !== undefined
      ) {
        work.analysis.due = Date.now();
      }
    });
  }

  private async releaseAnalysis(live?: number | null): Promise<void> {
    await this.updateWork((work): void => {
      if (work.analysis && work.analysis.due === undefined) {
        work.analysis.due = Date.now();
      }

      if (live === null) {
        delete work.live;
      } else if (live !== undefined) {
        work.live = live;
      }
    });
  }

  async reserve(context: CallContext, operationId: string, now: string): Promise<CallOutcome<{ id: string }>> {
    return this.ctx.blockConcurrencyWhile(() =>
      captureOutcome(async () => {
        await this.ctx.storage.put("context", context);
        this.context = context;

        // The coordinator owns the reservation write and is already wakeable
        // if the request disappears after D1 accepts the batch.
        await this.scheduleLive(Date.parse(now) + startupTimeout);

        try {
          const reservation = await reserveLiveCall(
            this.env.DB,
            context.userId,
            operationId,
            now,
            resolveUsageLimits(this.env),
            this.env.ENVIRONMENT,
            context.callId,
          );

          if (reservation.id !== context.callId) {
            await this.scheduleLive(null);
          }

          return reservation;
        } catch (error) {
          if (error instanceof BusinessError && error.status < 500) {
            await this.scheduleLive(null);
          }

          throw error;
        }
      }),
    );
  }

  async submitAnalysis(command: AnalysisCommand): Promise<CallOutcome<Call | AnalysisJob>> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const pending = (await this.ctx.storage.get<CallWork>("work"))?.command;

      if (pending) {
        const outcome = await this.commitAnalysisCommand(pending.input, true);

        if ("error" in outcome && outcome.error.status >= 500) {
          return outcome;
        }
      }

      await this.updateWork((work): void => {
        work.command = { input: command, due: Date.now() + recoveryDelay };
      });

      return this.commitAnalysisCommand(command);
    });
  }

  private async commitAnalysisCommand(
    command: AnalysisCommand,
    replay = false,
  ): Promise<CallOutcome<Call | AnalysisJob>> {
    const outcome = await captureOutcome<Call | AnalysisJob>(async () => {
      if (command.action === "retry") {
        return retryAnalysis(this.env.DB, command.context, command.version);
      }

      requireCondition(
        !(await findLiveSession(this.env.DB, command.context.callId)),
        "coordinator_required",
        "Use the live call hang-up action.",
      );

      return finalizeCall(this.env.DB, command.context, command.input, command.completedAt);
    });

    if ("error" in outcome && outcome.error.status >= 500) {
      return outcome;
    }

    // Access can change after a successful D1 commit loses its response.
    // Recover an existing job even if the original command now gets a 4xx.
    const callId = command.context.callId;
    const job =
      "result" in outcome
        ? { callId, version: "version" in outcome.result ? outcome.result.version : 1 }
        : replay
          ? await findPendingAnalysis(this.env.DB, callId)
          : null;

    await this.updateWork((work): void => {
      if (job && (!work.analysis || work.analysis.version < job.version)) {
        work.analysis = { ...job, due: Date.now() };
      }

      delete work.command;
    });

    return outcome;
  }

  private haltProvider(): void {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    try {
      this.socket.send(
        JSON.stringify({
          type: "session.close",
          event_id: crypto.randomUUID(),
        }),
      );
    } catch {
      this.socket.close();
      this.socket = null;
    }
  }

  private isStub(): boolean {
    return this.env.ENVIRONMENT === "local" && this.env.VOICE_PROVIDER === "stub";
  }

  private enqueue(command: () => Promise<void>): void {
    this.queue = this.queue.then(command).catch(async (): Promise<void> => {
      this.closing = true;
      this.haltProvider();

      await this.closeCall("Interrupted", "The call was interrupted. Your saved agreements are preserved.").catch(
        (): void => {},
      );
    });

    this.ctx.waitUntil(this.queue);
  }

  async start(
    context: CallContext,
    offerSdp: string,
  ): Promise<{
    id: string;
    answerSdp: string;
    provider: "openai" | "stub";
  }> {
    // Expected startup failures must leave the concurrency gate intact so its
    // alarm can reconcile usage and terminate an uncertain provider session.
    const outcome = await this.ctx.blockConcurrencyWhile(
      async (): Promise<
        | { result: Awaited<ReturnType<LiveCall["startSession"]>>; error?: undefined }
        | { error: { code: string; message: string; status: BusinessError["status"] }; result?: undefined }
      > => {
        try {
          return { result: await this.startSession(context, offerSdp) };
        } catch (error) {
          return {
            error:
              error instanceof BusinessError
                ? {
                    code: error.code,
                    message: error.message,
                    status: error.status,
                  }
                : {
                    code: "provider_unavailable",
                    message: "Voice startup failed. Try a new call.",
                    status: 503 as const,
                  },
          };
        }
      },
    );

    if (outcome.error) {
      throw new BusinessError(outcome.error.code, outcome.error.message, outcome.error.status);
    }

    return outcome.result!;
  }

  private async startSession(
    context: CallContext,
    offerSdp: string,
  ): Promise<{
    id: string;
    answerSdp: string;
    provider: "openai" | "stub";
  }> {
    this.context = context;
    await this.ctx.storage.put("context", context);
    const { session } = await this.readSession();

    requireCondition(
      session.state === "connecting" || session.state === "connected",
      "call_ended",
      "This call already ended. Start a new call.",
    );

    if (session.answerSdp) {
      return {
        id: context.callId,
        answerSdp: session.answerSdp,
        provider: this.isStub() ? ("stub" as const) : ("openai" as const),
      };
    }

    requireCondition(
      !session.providerAttempted,
      "startup_uncertain",
      "The previous start is being reconciled. Start a new call after it ends.",
    );

    await this.scheduleLive(Date.now() + 2000);

    try {
      requireCondition(
        this.isStub() || this.env.OPENAI_API_KEY,
        "provider_unavailable",
        "Voice credentials are unavailable. Browse samples or configure the local API.",
        503,
      );

      await this.updateSession((current): void => {
        requireCondition(
          current.state === "connecting" && !current.providerAttempted,
          "call_ended",
          "This call can no longer start.",
        );

        current.providerAttempted = true;
      });

      if (this.isStub()) {
        await this.updateSession((current): void => {
          current.providerId = `stub-${context.callId}`;
          current.answerSdp = "stub-answer";
          current.state = "connected";
        });
      } else {
        const response = await fetch("https://api.openai.com/v1/live/sessions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            session: createSessionConfiguration(),
            transport: { type: "webrtc", sdp: offerSdp },
          }),
          signal: AbortSignal.timeout(15_000),
        });

        if (!response.ok) {
          // An HTTP rejection confirms that no running session was created.
          // Its spending remains unconfirmed, but it must not occupy a voice slot.
          await this.updateSession((current): void => {
            current.providerClosed = true;
          });

          throw new BusinessError(
            "provider_unavailable",
            "Voice startup failed. The call is saved; retry with a new call.",
            503,
          );
        }

        const created = sessionResponseSchema.parse(await response.json());

        await this.updateSession((current): void => {
          current.providerId = created.session.id;
          current.answerSdp = created.transport.sdp;
        });

        await this.attach(created.session.id);

        await this.updateSession((current): void => {
          requireCondition(
            current.state === "connecting" && !current.providerClosed,
            "call_ended",
            "This call already ended.",
          );
          current.state = "connected";
        });
      }

      const connected = await this.readSession();

      return {
        id: context.callId,
        answerSdp: connected.session.answerSdp!,
        provider: this.isStub() ? ("stub" as const) : ("openai" as const),
      };
    } catch (error) {
      await this.closeCall("Connection failed", "Could not connect. Your call record is saved.");

      if (error instanceof BusinessError) {
        throw error;
      }

      throw new BusinessError("provider_unavailable", "Voice startup failed. Try a new call.", 503);
    }
  }

  private async readSession(): Promise<{
    state: import("@voice-freight/backend/model").State;
    call: import("@voice-freight/backend/model").CallRecord;
    session: import("@voice-freight/backend/model").LiveSession;
  }> {
    this.context ??= (await this.ctx.storage.get<CallContext>("context")) ?? null;
    requireCondition(this.context, "call_unavailable", "Call unavailable.", 404);
    const { state } = await readState(this.env.DB);

    const call = state.calls.find(
      (entry): boolean => entry.id === this.context!.callId && entry.ownerId === this.context!.userId,
    );

    const session = state.liveSessions.find((entry): boolean => entry.id === this.context!.callId);
    requireCondition(call && session, "call_unavailable", "Call unavailable.", 404);
    return { state, call, session };
  }

  async connectAudio(): Promise<void> {
    const { session } = await this.readSession();
    requireCondition(!this.closing && session.state === "connected", "call_ended", "This call is no longer active.");

    if (await this.ctx.storage.get("greeted")) {
      return;
    }

    await this.ctx.storage.put("greeted", true);

    await this.send({
      type: "session.commentary.append",
      event_id: crypto.randomUUID(),
      delegation_id: null,
      content: greeting,
    });
  }

  private async updateSession<T>(
    command: (session: Awaited<ReturnType<LiveCall["readSession"]>>["session"]) => T,
  ): Promise<T> {
    const context = this.context;
    requireCondition(context, "call_unavailable", "Call unavailable.", 404);

    return transact(this.env.DB, (state): T => {
      const session = state.liveSessions.find((entry): boolean => entry.id === context.callId);
      requireCondition(session, "call_unavailable", "Call unavailable.", 404);
      return command(session);
    });
  }

  private async attach(providerId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout((): void => controller.abort(), 10_000);
    let response: Response;

    try {
      response = await fetch(`https://api.openai.com/v1/live/sessions/${encodeURIComponent(providerId)}/attach`, {
        headers: {
          Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
          Upgrade: "websocket",
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const socket = response.webSocket;
    requireCondition(socket, "sideband_unavailable", "The voice coordinator could not connect.", 503);
    socket.accept();
    this.socket = socket;

    socket.addEventListener("message", (message): void => {
      if (typeof message.data !== "string") {
        return;
      }

      // Reflected audio is deliberately discarded, never stored or logged.
      let event: unknown;

      try {
        event = JSON.parse(message.data);
      } catch {
        this.enqueue(async (): Promise<void> => {
          throw new Error("Invalid provider event");
        });

        return;
      }

      const parsed = providerEventSchema.safeParse(event);

      if (!parsed.success || parsed.data.type.includes("audio.")) {
        return;
      }

      this.enqueue((): Promise<void> => this.observe(event));
    });

    socket.addEventListener("close", (): void => {
      if (this.socket !== socket) {
        return;
      }

      this.socket = null;

      this.enqueue(async (): Promise<void> => {
        const { session } = await this.readSession();

        if (!session.providerClosed) {
          await this.updateSession((current): void => {
            current.gap = true;
            current.accountingGap = true;
          });
          await this.closeCall("Interrupted", "Connection interrupted. Your partial transcript is saved.");
        }
      });
    });

    socket.addEventListener("error", (): void =>
      this.enqueue(async (): Promise<void> => {
        await this.updateSession((current): void => {
          current.gap = true;
          current.accountingGap = true;
        });
        await this.closeCall("Interrupted", "Voice connection failed. Your partial transcript is saved.");
      }),
    );
  }

  private async send(event: Record<string, unknown>): Promise<void> {
    if (this.isStub()) {
      const outgoing = (await this.ctx.storage.get<Record<string, unknown>[]>("fixtureOutput")) ?? [];
      outgoing.push(event);
      await this.ctx.storage.put("fixtureOutput", outgoing);
      return;
    }

    requireCondition(
      this.socket?.readyState === WebSocket.OPEN,
      "sideband_unavailable",
      "Voice connection unavailable.",
      503,
    );

    this.socket.send(JSON.stringify(event));
  }

  private async observe(input: unknown): Promise<void> {
    const event = providerEventSchema.parse(input);

    if (!(await ingestProviderEvent(this.env.DB, this.context!, event))) {
      return;
    }

    if (event.type === "session.closed") {
      await this.finish();
      return;
    }

    if ((await this.readSession()).session.providerClosed) {
      await this.finish();
      return;
    }

    if (event.type === "error") {
      await this.closeCall("Interrupted", "The voice service could not continue. Your call is saved.");
      return;
    }

    if (!(await this.checkAllowance())) {
      return;
    }

    const functionEvent = functionEventSchema.safeParse(event);

    if (functionEvent.success) {
      const invocation = functionEvent.data;
      const pendingId = `pending:${invocation.event.item.call_id}`;

      const { session } = await this.readSession();

      if (session.state !== "connected" || session.submittedCallIds.includes(invocation.event.item.call_id)) {
        await this.ctx.storage.delete(pendingId);
        return;
      }

      await this.ctx.storage.put(pendingId, invocation);

      if (this.isStub() || invocation.event.item.name === "end_call") {
        await this.executeFunction(invocation);
      } else {
        // Let transcript fragments following the tool event arrive before checking
        // confirmation. No transcript event itself marks a completed caller turn.
        this.ctx.waitUntil(
          new Promise<void>((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 1500)).then((): void => {
            this.ctx.waitUntil(
              this.executeFunction(invocation).catch(async (): Promise<void> => {
                await this.closeCall("Interrupted", "The call was interrupted. Your saved agreements are preserved.");
              }),
            );
          }),
        );
      }
    }

    if (event.type === "response.event") {
      const nested = providerEventSchema.parse(event.event);

      if (
        ["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(nested.type)
      ) {
        await this.continueResponse(z.string().parse(event.delegation_id));
      }
    }
  }

  private async beginFarewell(
    delegationId: string,
    input: unknown,
  ): Promise<{ status: "ending"; message: string } | { error: { code: string; message: string } }> {
    if (!voiceToolArguments.end_call.safeParse(input).success) {
      return { error: { code: "invalid_input", message: "end_call takes no arguments." } };
    }

    const { call, session } = await this.readSession();

    const deadline = new Date(
      Math.min(
        Date.now() + 4000,
        Date.parse(call.record.startedAt) + session.maximumCallSeconds * 1000,
        Date.parse(session.lastInputAt) + session.inactivitySeconds * 1000,
      ),
    ).toISOString();

    await this.scheduleLive(Math.min(Date.parse(deadline), Date.now() + 1000));

    await this.updateSession((current): void => {
      requireCondition(!this.closing && current.state === "connected", "call_ended", "This call is no longer active.");

      current.state = "ending";
      current.farewell = { deadline, delegationId };
    });

    await this.send({ type: "session.input_audio.mute", event_id: crypto.randomUUID() });

    return {
      status: "ending",
      message: "Say only: Thank you for calling. Goodbye.",
    };
  }

  private async executeFunction(invocation: z.infer<typeof functionEventSchema>): Promise<void> {
    const id = invocation.event.item.call_id;
    if (this.invocations.has(id)) {
      return;
    }
    this.invocations.add(id);
    try {
      await this.applyFunction(invocation);
    } finally {
      this.invocations.delete(id);
    }
  }

  private async applyFunction(invocation: z.infer<typeof functionEventSchema>): Promise<void> {
    const {
      event: { item },
      delegation_id: delegationId,
    } = invocation;

    const { session } = await this.readSession();

    if (this.closing || session.state !== "connected" || session.submittedCallIds.includes(item.call_id)) {
      return;
    }

    if (!(await this.checkAllowance())) {
      return;
    }

    let argumentsData: unknown;

    try {
      argumentsData = JSON.parse(item.arguments);
    } catch {
      argumentsData = null;
    }

    const result =
      item.name === "end_call"
        ? await this.beginFarewell(delegationId, argumentsData)
        : await this.env.TOOLS.executeObserved(this.context!, item.name, {
            invocationId: item.call_id,
            arguments: argumentsData,
          });

    const current = await this.readSession();

    if (
      current.session.state !== "connected" &&
      !(item.name === "end_call" && current.session.farewell?.delegationId === delegationId)
    ) {
      return;
    }

    await this.send({
      type: "response.item.create",
      event_id: `result-${item.call_id}`,
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(projectVoiceResult(result)),
      },
    });

    await this.updateSession((entry): void => {
      entry.submittedCallIds.push(item.call_id);
      (entry.delegationCallIds[delegationId] ??= []).push(item.call_id);
    });

    await this.ctx.storage.delete(`pending:${item.call_id}`);
    await this.continueResponse(delegationId);
  }

  private async continueResponse(delegationId: string): Promise<void> {
    const { session } = await this.readSession();

    if (this.closing || (session.state !== "connected" && session.farewell?.delegationId !== delegationId)) {
      return;
    }

    const pending = await this.ctx.storage.list({ prefix: "pending:" });

    if (
      [...pending.values()].some((entry): boolean => functionEventSchema.parse(entry).delegation_id === delegationId)
    ) {
      return;
    }

    const count = session.continuations[delegationId] ?? 0;
    // A continuation belongs to the batch of newly submitted results, not every
    // repeated response.completed event. Persist that batch before sending.
    const submitted = session.delegationCallIds[delegationId] ?? [];
    const marker = `${delegationId}:${submitted.length}`;

    if (!submitted.length || (await this.ctx.storage.get(marker))) {
      return;
    }

    if (count >= maximumContinuationCount) {
      await this.closeCall("Interrupted", "The voice service reached its work limit. Your call is saved.");
      return;
    }

    if (!(await this.checkAllowance())) {
      return;
    }

    await this.ctx.storage.put(marker, true);

    await this.updateSession((entry): void => {
      entry.continuations[delegationId] = count + 1;
    });

    await this.send({
      type: "response.create",
      event_id: `continue-${crypto.randomUUID()}`,
    });
  }

  private async checkAllowance(): Promise<boolean> {
    const { state, session } = await this.readSession();

    if (this.closing || (session.state !== "connected" && !session.farewell)) {
      return false;
    }

    const reservation = state.reservations.find((entry): boolean => entry.id === session.id);
    requireCondition(reservation, "accounting_unavailable", "Spending accounting unavailable.", 503);

    if (
      reservation.reservedMicrodollars - reservation.chargedMicrodollars <= shutdownHeadroomMicrodollars ||
      calculateAvailableMicrodollars(state, new Date().toISOString()) < 0 ||
      session.responseIds.length >= maximumResponseCount
    ) {
      await this.closeCall(
        "Ended normally",
        "The shared spending allowance or call work limit was reached. Your call is saved. The monthly allowance renews at 00:00 UTC on the first day.",
      );

      return false;
    }

    return true;
  }

  async end(
    connection: "Ended normally" | "Interrupted" | "Connection failed" = "Ended normally",
    notice: string | null = null,
  ): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => this.closeCall(connection, notice));
  }

  private async closeCall(
    connection: "Ended normally" | "Interrupted" | "Connection failed" = "Ended normally",
    notice: string | null = null,
    abandonedStartup = false,
  ): Promise<void> {
    this.closing = true;

    try {
      const { session } = await this.readSession();

      if (session.state === "ended" || (session.state === "ending" && !session.farewell)) {
        return;
      }

      const now = new Date().toISOString();
      await this.scheduleLive(Date.now() + 1000);
      await this.stageAnalysis({ callId: session.id, version: 1 });

      const closing = await observeOperation({ callId: session.id, function: "call", action: "ending" }, () =>
        transact(this.env.DB, (state): typeof session | null => {
          const current = state.liveSessions.find((entry): boolean => entry.id === session.id)!;

          if (
            current.state === "ended" ||
            (current.state === "ending" && !current.farewell) ||
            (abandonedStartup && (current.state !== "connecting" || current.providerAttempted))
          ) {
            return null;
          }

          current.state = "ending";
          current.notice = notice;
          current.closingAt = now;
          delete current.farewell;

          if (connection !== "Ended normally") {
            current.gap = true;
          }

          if (!this.isStub() && current.providerAttempted && !current.providerClosed && !this.socket) {
            current.accountingGap = true;
          }

          completeCall(state, this.context!, { connection, transcriptComplete: false }, now);
          return current;
        }),
      );

      if (!closing) {
        return;
      }

      if (!closing.providerAttempted) {
        await this.finish();
      } else if (this.isStub()) {
        await ingestProviderEvent(this.env.DB, this.context!, {
          type: "session.closed",
          event_id: `closed-${closing.id}`,
          usage: {
            seconds: Math.max(
              closing.voiceSeconds,
              (Date.now() - Date.parse((await this.readSession()).call.record.startedAt)) / 1000,
            ),
          },
        });

        await this.finish();
      } else if (this.socket?.readyState === WebSocket.OPEN) {
        await this.send({
          type: "session.close",
          event_id: crypto.randomUUID(),
        });
      } else if (closing.providerClosed) {
        await this.finish();
      }
    } finally {
      if (!this.isStub()) {
        this.haltProvider();
      }
    }
  }

  private async finish(): Promise<void> {
    const { call, session } = await this.readSession();

    if (session.state !== "ended" || !call.finalSnapshot) {
      await this.stageAnalysis({ callId: session.id, version: 1 });
    }

    const needsClosure = await transact(this.env.DB, (state): boolean => {
      const current = state.liveSessions.find((entry): boolean => entry.id === session.id)!;
      const call = state.calls.find((entry): boolean => entry.id === session.id)!;
      const reservation = state.reservations.find((entry): boolean => entry.id === session.id)!;

      if (!call.finalSnapshot) {
        completeCall(
          state,
          this.context!,
          { connection: current.farewell ? "Ended normally" : "Interrupted", transcriptComplete: false },
          new Date().toISOString(),
        );

        if (!current.farewell) {
          current.gap = true;
          current.notice ??= "The voice session closed unexpectedly. Your partial call is saved.";
        }
      }

      current.state = "ended";
      delete current.farewell;
      const complete = current.providerClosed && !current.gap;
      call.record.transcript.complete = complete;

      if (
        !current.providerAttempted ||
        (!current.accountingGap &&
          current.usageConfirmed &&
          current.responseIds.every((id): boolean => current.completedResponseIds.includes(id)))
      ) {
        reservation.settled = true;
      }

      return current.providerAttempted && !current.providerClosed && Boolean(current.providerId) && !this.isStub();
    });

    if (!needsClosure) {
      this.disconnectProvider();
    }

    await this.releaseAnalysis(needsClosure ? Date.now() + 1000 : null);
  }

  private disconnectProvider(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000);
  }

  private async reconcileClosure(providerId: string): Promise<void> {
    const now = Date.now();
    const lastRecovery = await this.ctx.storage.get<number>("lastRecovery");
    this.disconnectProvider();

    if (lastRecovery !== undefined && now < lastRecovery + closureRetryInterval) {
      await this.scheduleLive(lastRecovery + closureRetryInterval);
      return;
    }

    const unresolved = await this.updateSession((current): boolean => {
      if (current.state !== "ended" || current.providerClosed) {
        return false;
      }

      current.gap = true;
      current.accountingGap = true;
      return true;
    });

    if (!unresolved) {
      await this.finish();
      return;
    }

    await this.ctx.storage.put("lastRecovery", now);
    await this.attach(providerId);
    this.haltProvider();
    await this.scheduleLive(Date.now() + 10_000);
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async (): Promise<void> => {
      const now = Date.now();

      const liveDue = await this.updateWork((work): boolean => {
        if (work.live === undefined || work.live > now) {
          return false;
        }

        work.live = now + recoveryDelay;
        return true;
      });

      if (liveDue) {
        await this.advanceLive();
      }
    });

    await this.ctx.blockConcurrencyWhile(async (): Promise<void> => {
      const clock = Date.now();

      const pending = await this.updateWork((work): CallWork => {
        const command = work.command && work.command.due <= clock ? work.command : undefined;
        const analysis = work.analysis?.due !== undefined && work.analysis.due <= clock ? work.analysis : undefined;

        if (command) {
          command.due = clock + recoveryDelay;
        }

        if (analysis) {
          analysis.due = clock + recoveryDelay;
        }

        return { command, analysis };
      });

      try {
        if (pending.command) {
          await this.commitAnalysisCommand(pending.command.input, true);
        }

        if (pending.analysis) {
          const { callId, version, due } = pending.analysis;
          const wakeup = await observeOperation({ callId, version, function: "analysis", action: "dispatch" }, () =>
            this.env.TOOLS.dispatchAnalysis({ callId, version }),
          );

          await this.updateWork((work): void => {
            if (work.analysis?.version === version && work.analysis.due === due) {
              if (wakeup === null) {
                delete work.analysis;
              } else {
                work.analysis.due = wakeup;
              }
            }
          });
        }
      } catch {
        // The fallback was committed before either operation and owns retry.
      }
    });
  }

  private async advanceLive(): Promise<void> {
    try {
      this.context ??= (await this.ctx.storage.get<CallContext>("context")) ?? null;
      const context = this.context;
      requireCondition(context, "call_unavailable", "Call unavailable.", 404);
      let live = await findLiveSession(this.env.DB, context.callId);

      if (!live) {
        // A guarded D1 batch fences any outstanding reservation write from
        // the old coordinator instance that read an earlier revision.
        live = await transact(
          this.env.DB,
          (state) => state.liveSessions.find((row) => row.id === context.callId) ?? null,
        );

        if (!live) {
          await this.scheduleLive(null);
          return;
        }
      }

      if (live.state === "ended") {
        if (live.providerId && !live.providerClosed && !this.isStub()) {
          await this.releaseAnalysis();
          await this.reconcileClosure(live.providerId);
        } else if (live.providerClosed) {
          await this.finish();
        } else {
          this.disconnectProvider();
          await this.releaseAnalysis(null);
        }

        return;
      }

      const { session, call } = await this.readSession();

      if (this.closing && session.state === "connected") {
        await this.closeCall("Interrupted", "Usage accounting was interrupted. Your partial call is saved.");
        return;
      }

      if (session.state === "connecting" && !session.providerAttempted) {
        const deadline = Date.parse(call.record.startedAt) + startupTimeout;

        if (Date.now() >= deadline) {
          await this.closeCall("Connection failed", "Call startup was abandoned before contacting the provider.", true);
        } else {
          await this.scheduleLive(deadline);
        }

        return;
      }

      if (session.state === "ending" && session.farewell) {
        if (!(await this.checkAllowance())) {
          return;
        }

        const deadline = Date.parse(session.farewell.deadline);

        if (Date.now() >= deadline) {
          await this.closeCall();
        } else {
          await this.scheduleLive(Math.min(deadline, Date.now() + 1000));
        }

        return;
      }

      if (session.state === "ending") {
        const closingAt = session.closingAt ?? new Date().toISOString();

        if (!session.closingAt || !call.finalSnapshot) {
          await this.stageAnalysis({ callId: session.id, version: 1 });

          await transact(this.env.DB, (state): void => {
            const current = state.liveSessions.find((entry): boolean => entry.id === session.id)!;
            current.closingAt ??= closingAt;

            completeCall(
              state,
              this.context!,
              { connection: "Interrupted", transcriptComplete: false },
              new Date().toISOString(),
            );

            current.gap = true;
          });
        }

        if (!this.socket && session.providerId && !this.isStub() && !session.providerClosed) {
          const attempts = (await this.ctx.storage.get<number>("recoveryAttempts")) ?? 0;

          if (attempts < 2) {
            await this.ctx.storage.put("recoveryAttempts", attempts + 1);

            await this.updateSession((current): void => {
              current.gap = true;
              current.accountingGap = true;
            });

            await this.attach(session.providerId);

            await this.send({
              type: "session.close",
              event_id: crypto.randomUUID(),
            });
          }
        }

        if (Date.now() - Date.parse(closingAt) >= 10_000) {
          await this.finish();
          this.disconnectProvider();
          return;
        }
      } else {
        if (!this.isStub() && !this.socket) {
          await this.closeCall("Interrupted", "The voice coordinator restarted. Your partial call is saved.");
          return;
        }

        if (!(await this.checkAllowance())) {
          return;
        }

        const elapsed = (Date.now() - Date.parse(call.record.startedAt)) / 1000;
        const idle = (Date.now() - Date.parse(session.lastInputAt)) / 1000;

        if (elapsed >= session.maximumCallSeconds || idle >= session.inactivitySeconds) {
          await this.closeCall(
            "Ended normally",
            elapsed >= session.maximumCallSeconds
              ? "The call duration limit was reached."
              : `The call ended after ${session.inactivitySeconds} seconds without caller speech.`,
          );

          return;
        }

        const warningSeconds = Math.min(30, Math.max(1, Math.floor(session.inactivitySeconds / 4)));

        if (idle >= session.inactivitySeconds - warningSeconds && !session.warned) {
          await this.updateSession((current): void => {
            current.warned = true;
            current.notice = `Are you still there? Speak within ${warningSeconds} seconds to keep the call active.`;
          });

          await this.send({
            type: "session.commentary.append",
            event_id: crypto.randomUUID(),
            delegation_id: null,
            content: `Are you still there? This call will end in ${warningSeconds} seconds unless you speak.`,
          });
        }

        if (this.isStub() && !(await this.ctx.storage.get("fixtureStarted"))) {
          await this.ctx.storage.put("fixtureStarted", true);
          await this.runFixture(this.env.VOICE_STUB_SCENARIO ?? "workflow");
        }
      }

      await this.scheduleLive(Date.now() + 1000);
    } catch {
      this.closing = true;
      this.haltProvider();

      await this.closeCall(
        "Interrupted",
        "Usage accounting or the voice coordinator is unavailable. Your call is saved.",
      ).catch((): void => {});

      const work = await this.ctx.storage.get<CallWork>("work");

      if (work?.live !== undefined) {
        await this.scheduleLive(Date.now() + 5000);
      }
    }
  }

  async observeFixture(event: unknown): Promise<void> {
    requireCondition(this.isStub(), "forbidden", "Provider fixtures are disabled.", 403);
    await this.readSession();
    await this.observe(event);
  }

  async getFixtureOutput(): Promise<
    {
      type: string;
      json: string;
    }[]
  > {
    requireCondition(this.isStub(), "forbidden", "Provider fixtures are disabled.", 403);
    const outgoing = (await this.ctx.storage.get<Record<string, unknown>[]>("fixtureOutput")) ?? [];

    return outgoing.map((event): { type: string; json: string } => ({
      type: String(event.type),
      json: JSON.stringify(event),
    }));
  }

  async runFixture(scenario: string): Promise<void> {
    requireCondition(this.isStub(), "forbidden", "Provider fixtures are disabled.", 403);
    await this.readSession();

    if (scenario === "idle") {
      return;
    }

    if (scenario === "budget-active") {
      await transact(this.env.DB, (state): void => {
        const reservation = state.reservations.find((entry): boolean => entry.id === this.context!.callId)!;
        reservation.reservedMicrodollars = shutdownHeadroomMicrodollars;
      });

      await this.checkAllowance();
      return;
    }

    const invoke = async (name: z.infer<typeof toolNameSchema>, argumentsData: unknown): Promise<void> => {
      await this.observe({
        type: "response.event",
        event_id: crypto.randomUUID(),
        delegation_id: `fixture-${name}-${crypto.randomUUID()}`,
        event: {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: crypto.randomUUID(),
            name,
            arguments: JSON.stringify(argumentsData),
          },
        },
      });
    };

    const readback = async (targetId: string, action: "handoff" | "cancel"): Promise<void> => {
      const { state, call } = await this.readSession();
      const quote = state.quotes.find((entry): boolean => entry.id === targetId);
      const agreement = state.agreements.find((entry): boolean => entry.id === targetId);
      const load = call.record.loads.find((entry): boolean => entry.id === (quote?.loadId ?? agreement?.load.id))!;
      const rateCents = quote?.rateCents ?? agreement!.rateCents;

      const startMs =
        Math.max(
          0,
          ...state.transcriptFragments
            .filter((entry): boolean => entry.callId === call.id)
            .map((entry): number => entry.endMs),
        ) + 1000;

      const speech = createReadback(
        state,
        call.id,
        load,
        rateCents,
        action === "cancel" ? "cancel" : quote?.replacementId ? "replace" : "handoff",
      );

      const boundary = speech.indexOf(". Do you accept");

      for (const [index, delta] of [speech.slice(0, boundary + 1), speech.slice(boundary + 1)].entries()) {
        await this.observe({
          type: "session.output_transcript.delta",
          event_id: crypto.randomUUID(),
          start_ms: startMs + index * 3000,
          end_ms: startMs + index * 3000 + 1000,
          delta,
        });
      }

      await this.observe({
        type: "session.input_transcript.delta",
        event_id: crypto.randomUUID(),
        start_ms: startMs + 6000,
        end_ms: startMs + 6500,
        delta: scenario === "confirmation-change" ? "Yes, but change the rate." : "Yes, confirmed.",
      });
      // Exercise the same progress speech that follows acceptance in live calls.
      await this.observe({
        type: "session.output_transcript.delta",
        event_id: crypto.randomUUID(),
        start_ms: startMs + 7000,
        end_ms: startMs + 7500,
        delta: "One sec.",
      });
      await this.updateSession((session): void => {
        session.lastInputAt = new Date(Date.now() - confirmationQuietMs - 1).toISOString();
      });
    };

    await invoke("verify_carrier", { mcNumber: "123456" });
    await invoke("search_loads", { origin: "Dallas" });
    const initial = await this.readSession();

    const loadIds = initial.call.inventoryIds
      .filter(
        (loadId): boolean =>
          !initial.state.agreements.some((entry): boolean => entry.load.id === loadId && entry.status === "effective"),
      )
      .slice(0, 2);

    for (const loadId of loadIds) {
      await invoke("select_load", { loadId });
      let current = await this.readSession();

      await invoke("evaluate_offer", {
        quoteId: current.call.quoteId,
        amountCents: 210000,
      });

      current = await this.readSession();
      await readback(current.call.quoteId!, "handoff");
      await invoke("confirm_handoff", { quoteId: current.call.quoteId });
    }

    let current = await this.readSession();

    const agreements = current.state.agreements.filter(
      (entry): boolean => entry.callId === current.call.id && entry.status === "effective",
    );

    const explainFailure = async (): Promise<void> => {
      const current = await this.readSession();
      const endMs = Math.max(
        0,
        ...current.state.transcriptFragments
          .filter((entry): boolean => entry.callId === current.call.id)
          .map((entry): number => entry.endMs),
      );
      await this.observe({
        type: "session.output_transcript.delta",
        event_id: crypto.randomUUID(),
        start_ms: endMs + 1000,
        end_ms: endMs + 2000,
        delta:
          scenario === "confirmation-change"
            ? "The agreement change was not saved. Let us discuss the requested rate and get a new quote before confirmation."
            : "The agreement change was not saved. Confirmation could not be checked. Your existing agreements are preserved. We can try again later.",
      });
    };

    if (agreements.length !== 2) {
      if (scenario === "confirmation-change") {
        await explainFailure();
      }
      return;
    }

    await readback(agreements[0].id, "cancel");
    await invoke("cancel_agreement", { agreementId: agreements[0].id });
    await invoke("begin_renegotiation", { agreementId: agreements[1].id });
    current = await this.readSession();
    await readback(current.call.quoteId!, "handoff");
    await invoke("confirm_handoff", { quoteId: current.call.quoteId });
    if (scenario === "confirmation-failure") {
      await explainFailure();
    }
  }
}
