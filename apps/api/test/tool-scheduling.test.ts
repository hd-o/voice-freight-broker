import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { readState } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { LiveCall } from "../src/live-call";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, new Date().toISOString());
});

it.each(["select_load", "evaluate_offer", "begin_renegotiation", "confirm_handoff", "cancel_agreement"])(
  "executes ordinary tools promptly and delays %s",
  async (name): Promise<void> => {
    const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
    const context = { userId: "reviewer", callId: id };
    const stub = env.CALLS.get(env.CALLS.idFromName(id));

    await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
      const pair = new WebSocketPair();
      const provider = pair[0];
      provider.accept();
      const messages: { type: string; item?: { call_id?: string } }[] = [];
      provider.addEventListener("message", (event): void => {
        messages.push(JSON.parse(String(event.data)));
      });

      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        return url.endsWith("/attach")
          ? new Response(null, { status: 101, webSocket: pair[1] })
          : Response.json({ session: { id: "provider-scheduling" }, transport: { sdp: "answer" } });
      });

      const sendTool = (name: string, callId: string, input: object): void => {
        provider.send(
          JSON.stringify({
            type: "response.event",
            event_id: crypto.randomUUID(),
            delegation_id: callId,
            event: {
              type: "response.output_item.done",
              item: { type: "function_call", call_id: callId, name, arguments: JSON.stringify(input) },
            },
          }),
        );
      };

      try {
        const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
        await coordinator.start(context, "offer");
        sendTool("verify_carrier", "verify", { mcNumber: "123456" });
        await expect
          .poll((): boolean => messages.some((message): boolean => message.item?.call_id === "verify"), {
            timeout: 1200,
            interval: 20,
          })
          .toBe(true);

        sendTool("search_loads", "search", { origin: "Texas" });
        await expect
          .poll((): boolean => messages.some((message): boolean => message.item?.call_id === "search"), {
            timeout: 1200,
            interval: 20,
          })
          .toBe(true);

        sendTool(name, "confirm", name === "select_load" ? { loadId: "seed-v1-01" } : {});
        await expect
          .poll((): Promise<unknown> => storage.storage.get("pending:confirm"), {
            timeout: 1000,
            interval: 20,
          })
          .not.toBeUndefined();
        provider.send(
          JSON.stringify({
            type: "session.input_transcript.delta",
            event_id: "late-fragment",
            start_ms: 1000,
            end_ms: 1500,
            delta: "I select that load.",
          }),
        );

        await expect
          .poll(async (): Promise<number> => (await readState(env.DB)).state.transcriptFragments.length)
          .toBe(1);
        expect(messages.some((message): boolean => message.item?.call_id === "confirm")).toBe(false);
        await expect
          .poll((): boolean => messages.some((message): boolean => message.item?.call_id === "confirm"), {
            timeout: 4000,
            interval: 20,
          })
          .toBe(true);

        if (name === "select_load") {
          expect((await readState(env.DB)).state.quotes[0].evidenceAfterMs).toBe(1500);
        }

        await coordinator.end();
      } finally {
        request.mockRestore();
        provider.close();
        await storage.storage.deleteAlarm();
        await storage.storage.deleteAll();
      }
    });
  },
);
