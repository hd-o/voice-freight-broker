import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { toolNameSchema, type CallContext } from "@voice-freight/contracts/business";
import { createReadback } from "@voice-freight/backend/readbacks";
import { completeCall } from "@voice-freight/backend/calls";
import { ingestProviderEvent, providerEventSchema } from "@voice-freight/backend/provider-events";
import { BusinessError, requireCondition } from "@voice-freight/backend/model";
import { readState, transact } from "@voice-freight/backend/repository";
import {
  calculateAvailableMicrodollars,
  maximumContinuationCount,
  maximumResponseCount,
  shutdownHeadroomMicrodollars,
} from "@voice-freight/backend/spending";
import { createSessionConfiguration, greeting } from "./live-configuration";
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
      name: toolNameSchema,
      arguments: z.string(),
    }),
  }),
});

export class LiveCall extends DurableObject<LiveBindings> {
  private socket: WebSocket | null = null;
  private queue: Promise<void> = Promise.resolve();
  private context: CallContext | null = null;
  private closing = false;

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

      await this.end("Interrupted", "The call was interrupted. Your saved agreements are preserved.").catch(
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

    await this.ctx.storage.setAlarm(Date.now() + 2000);

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
      await this.end("Connection failed", "Could not connect. Your call record is saved.");

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

  private async updateSession(
    command: (session: Awaited<ReturnType<LiveCall["readSession"]>>["session"]) => void,
  ): Promise<void> {
    const context = this.context;
    requireCondition(context, "call_unavailable", "Call unavailable.", 404);

    await transact(this.env.DB, (state): void => {
      const session = state.liveSessions.find((entry): boolean => entry.id === context.callId);
      requireCondition(session, "call_unavailable", "Call unavailable.", 404);
      command(session);
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
      this.socket = null;

      this.enqueue(async (): Promise<void> => {
        const { session } = await this.readSession();

        if (!session.providerClosed) {
          await this.end("Interrupted", "Connection interrupted. Your partial transcript is saved.");
        }
      });
    });

    socket.addEventListener("error", (): void =>
      this.enqueue(async (): Promise<void> => {
        await this.end("Interrupted", "Voice connection failed. Your partial transcript is saved.");
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
      await this.end("Interrupted", "The voice service could not continue. Your call is saved.");
      return;
    }

    if (!(await this.checkAllowance())) {
      return;
    }

    const functionEvent = functionEventSchema.safeParse(event);

    if (functionEvent.success) {
      const invocation = functionEvent.data;
      const pendingId = `pending:${invocation.event.item.call_id}`;

      if ((await this.readSession()).session.submittedCallIds.includes(invocation.event.item.call_id)) {
        await this.ctx.storage.delete(pendingId);
        return;
      }

      await this.ctx.storage.put(pendingId, invocation);

      if (this.isStub()) {
        await this.executeFunction(invocation);
      } else {
        // Let transcript fragments following the tool event arrive before checking
        // confirmation. No transcript event itself marks a completed caller turn.
        this.ctx.waitUntil(
          new Promise<void>((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 1500)).then((): void => {
            this.enqueue((): Promise<void> => this.executeFunction(invocation));
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

  private async executeFunction(invocation: z.infer<typeof functionEventSchema>): Promise<void> {
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

    const result = await this.env.TOOLS.executeObserved(this.context!, item.name, {
      invocationId: item.call_id,
      arguments: argumentsData,
    });

    const current = await this.readSession();

    if (current.session.state !== "connected") {
      return;
    }

    await this.send({
      type: "response.item.create",
      event_id: `result-${item.call_id}`,
      item: {
        type: "function_call_output",
        call_id: item.call_id,
        output: JSON.stringify(result),
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
    const pending = await this.ctx.storage.list({ prefix: "pending:" });

    if (
      [...pending.values()].some((entry): boolean => functionEventSchema.parse(entry).delegation_id === delegationId)
    ) {
      return;
    }

    const { session } = await this.readSession();
    const count = session.continuations[delegationId] ?? 0;
    // A continuation belongs to the batch of newly submitted results, not every
    // repeated response.completed event. Persist that batch before sending.
    const submitted = session.delegationCallIds[delegationId] ?? [];
    const marker = `${delegationId}:${submitted.length}`;

    if (!submitted.length || (await this.ctx.storage.get(marker))) {
      return;
    }

    if (count >= maximumContinuationCount) {
      await this.end("Interrupted", "The voice service reached its work limit. Your call is saved.");
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

    if (this.closing || session.state !== "connected") {
      return false;
    }

    const reservation = state.reservations.find((entry): boolean => entry.id === session.id);
    requireCondition(reservation, "accounting_unavailable", "Spending accounting unavailable.", 503);

    if (
      reservation.reservedMicrodollars - reservation.chargedMicrodollars <= shutdownHeadroomMicrodollars ||
      calculateAvailableMicrodollars(state, new Date().toISOString()) < 0 ||
      session.responseIds.length >= maximumResponseCount
    ) {
      await this.end(
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
    this.closing = true;

    try {
      const { session } = await this.readSession();

      if (session.state === "ended" || session.state === "ending") {
        return;
      }

      const now = new Date().toISOString();

      await transact(this.env.DB, (state): void => {
        const current = state.liveSessions.find((entry): boolean => entry.id === session.id)!;
        current.state = "ending";
        current.notice = notice;
        current.closingAt = now;

        if (connection !== "Ended normally") {
          current.gap = true;
        }

        completeCall(state, this.context!, { connection, transcriptComplete: false }, now);
      });

      await this.ctx.storage.setAlarm(Date.now() + 1000);

      if (this.isStub()) {
        await ingestProviderEvent(this.env.DB, this.context!, {
          type: "session.closed",
          event_id: `closed-${session.id}`,
          usage: {
            seconds: Math.max(
              session.voiceSeconds,
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
      } else if (!session.providerAttempted || session.providerClosed) {
        await this.finish();
      }
    } finally {
      if (!this.isStub()) {
        this.haltProvider();
      }
    }
  }

  private async finish(): Promise<void> {
    const { session } = await this.readSession();

    const providerClosed = await transact(this.env.DB, (state): boolean => {
      const current = state.liveSessions.find((entry): boolean => entry.id === session.id)!;
      const call = state.calls.find((entry): boolean => entry.id === session.id)!;
      const reservation = state.reservations.find((entry): boolean => entry.id === session.id)!;

      if (!call.finalSnapshot) {
        completeCall(
          state,
          this.context!,
          { connection: "Interrupted", transcriptComplete: false },
          new Date().toISOString(),
        );

        current.gap = true;
        current.notice ??= "The voice session closed unexpectedly. Your partial call is saved.";
      }

      current.state = "ended";
      const complete = current.providerClosed && !current.gap;
      call.record.transcript.complete = complete;

      if (
        !current.providerAttempted ||
        (current.usageConfirmed &&
          current.responseIds.every((id): boolean => current.completedResponseIds.includes(id)))
      ) {
        reservation.settled = true;
      }

      return current.providerClosed;
    });

    if (providerClosed) {
      this.socket?.close(1000);
      this.socket = null;
    }

    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    try {
      const { session, call } = await this.readSession();

      if (this.closing && session.state === "connected") {
        await this.end("Interrupted", "Usage accounting was interrupted. Your partial call is saved.");
        return;
      }

      if (session.state === "ended") {
        return;
      }

      if (session.state === "ending") {
        const closingAt = session.closingAt ?? new Date().toISOString();

        if (!session.closingAt || !call.finalSnapshot) {
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
          this.socket?.close();
          this.socket = null;
          return;
        }
      } else {
        if (!this.isStub() && !this.socket) {
          await this.end("Interrupted", "The voice coordinator restarted. Your partial call is saved.");
          return;
        }

        if (!(await this.checkAllowance())) {
          return;
        }

        const elapsed = (Date.now() - Date.parse(call.record.startedAt)) / 1000;
        const idle = (Date.now() - Date.parse(session.lastInputAt)) / 1000;

        if (elapsed >= session.maximumCallSeconds || idle >= session.inactivitySeconds) {
          await this.end(
            "Ended normally",
            elapsed >= session.maximumCallSeconds
              ? "The call duration limit was reached."
              : `The call ended after ${session.inactivitySeconds} seconds without caller speech.`,
          );

          return;
        }

        const warningSeconds = Math.min(15, Math.max(1, Math.floor(session.inactivitySeconds / 4)));

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

      await this.ctx.storage.setAlarm(Date.now() + 1000);
    } catch {
      this.closing = true;
      this.haltProvider();

      await this.end(
        "Interrupted",
        "Usage accounting or the voice coordinator is unavailable. Your call is saved.",
      ).catch((): void => {});

      await this.ctx.storage.setAlarm(Date.now() + 5000);
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

      const boundary = speech.indexOf(". Please say");

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
        delta: "Yes, confirmed.",
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

    if (agreements.length !== 2) {
      return;
    }

    await readback(agreements[0].id, "cancel");
    await invoke("cancel_agreement", { agreementId: agreements[0].id });
    await invoke("begin_renegotiation", { agreementId: agreements[1].id });
    current = await this.readSession();
    await readback(current.call.quoteId!, "handoff");
    await invoke("confirm_handoff", { quoteId: current.call.quoteId });
  }
}
