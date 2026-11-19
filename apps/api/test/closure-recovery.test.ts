import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import { reserveLiveCall, queryLiveStatus } from "@voice-freight/backend/live";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { calculateReservationHold } from "@voice-freight/backend/spending";
import { LiveCall } from "../src/live-call";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, new Date().toISOString());
});

it("reattaches immediately after a sideband loss and keeps uncertain delegated usage reserved", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const original = new WebSocketPair();
    const recovered = new WebSocketPair();
    original[0].accept();
    recovered[0].accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "provider-recovery" }, transport: { sdp: "answer" } }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: original[1] }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: recovered[1] }));

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      original[0].close(1011, "transport lost");
      await expect.poll((): number => request.mock.calls.length, { timeout: 1000, interval: 20 }).toBe(3);
      await expect.poll(async () => (await readState(env.DB)).state.liveSessions[0].accountingGap).toBe(true);
      recovered[0].send(JSON.stringify({ type: "session.closed", event_id: "recovered-close", usage: { seconds: 4 } }));
      await expect
        .poll(async (): Promise<boolean> => (await readState(env.DB)).state.liveSessions[0].providerClosed)
        .toBe(true);
      const { state } = await readState(env.DB);
      expect(state.liveSessions[0]).toMatchObject({ gap: true, accountingGap: true });
      expect(calculateReservationHold(state.reservations[0])).toBeGreaterThan(0);
      expect(state.reservations[0].settled).toBe(false);
    } finally {
      request.mockRestore();
      original[0].close();
      recovered[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("backs off failed closure recovery across coordinator restarts while retaining the hold", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();

    try {
      await transact(env.DB, (state): void => {
        const session = state.liveSessions[0];
        session.state = "ended";
        session.providerId = "provider-recovery";
        session.providerAttempted = true;
        session.gap = true;
        session.accountingGap = true;
      });
      await storage.storage.put("context", context);
      await storage.storage.put("work", { live: now });
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.alarm();
      expect(await storage.storage.get("closureRecovery")).toEqual({ attempts: 1, lastAttempt: now });
      expect((await storage.storage.get<{ live: number }>("work"))?.live).toBe(now + 300_000);
      vi.setSystemTime(now + 300_000);
      const restarted = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await restarted.alarm();
      expect(await storage.storage.get("closureRecovery")).toEqual({ attempts: 2, lastAttempt: now + 300_000 });
      expect((await storage.storage.get<{ live: number }>("work"))?.live).toBe(now + 1_200_000);
      expect(request).toHaveBeenCalledTimes(2);
      const { state } = await readState(env.DB);
      expect(state.liveSessions[0].providerClosed).toBe(false);
      expect(calculateReservationHold(state.reservations[0])).toBeGreaterThan(0);
    } finally {
      request.mockRestore();
      vi.useRealTimers();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("does not reattach after confirmed clean closure", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const pair = new WebSocketPair();
    pair[0].accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "provider-closed" }, transport: { sdp: "answer" } }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: pair[1] }));

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      await coordinator.end();
      pair[0].send(JSON.stringify({ type: "session.closed", event_id: "closed", usage: { seconds: 4 } }));
      await expect.poll(async (): Promise<string> => (await queryLiveStatus(env.DB, context)).state).toBe("ended");
      pair[0].close(1000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      request.mockRestore();
      pair[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("recovers delegated usage when the sideband disconnects after voice closure", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const original = new WebSocketPair();
    const recovered = new WebSocketPair();
    original[0].accept();
    recovered[0].accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "provider-recovery" }, transport: { sdp: "answer" } }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: original[1] }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: recovered[1] }));

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      const response = { id: "pending-response" };
      original[0].send(JSON.stringify({ type: "response.event", event: { type: "response.created", response } }));
      await expect.poll(async () => (await readState(env.DB)).state.liveSessions[0].responseIds).toEqual([response.id]);
      await coordinator.end();
      original[0].send(JSON.stringify({ type: "session.closed", event_id: "closed", usage: { seconds: 4 } }));
      await expect
        .poll(async (): Promise<boolean> => (await readState(env.DB)).state.liveSessions[0].providerClosed)
        .toBe(true);
      original[0].close(1011, "usage interrupted");
      await expect.poll((): number => request.mock.calls.length, { timeout: 1000, interval: 20 }).toBe(3);
      recovered[0].send(
        JSON.stringify({
          type: "response.event",
          event_id: "response-replay",
          event: {
            type: "response.completed",
            response: { ...response, usage: { input_tokens: 100, output_tokens: 50 } },
          },
        }),
      );
      await expect
        .poll(async () => (await readState(env.DB)).state.liveSessions[0].completedResponseIds)
        .toEqual([response.id]);
      expect((await readState(env.DB)).state.liveSessions[0].accountingGap).toBe(true);
    } finally {
      request.mockRestore();
      original[0].close();
      recovered[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("keeps the recovery count when an ended session's retry socket disconnects", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const pair = new WebSocketPair();
    pair[0].accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: pair[1] }));
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();

    try {
      await transact(env.DB, (state): void => {
        const session = state.liveSessions[0];
        session.state = "ended";
        session.providerId = "provider-recovery";
        session.providerAttempted = true;
        session.gap = true;
        session.accountingGap = true;
      });
      await storage.storage.put("context", context);
      await storage.storage.put("work", { live: now });
      await storage.storage.put("closureRecovery", { attempts: 2, lastAttempt: now - 900_000 });
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.alarm();
      pair[0].close(1011, "transport lost");
      await expect.poll(async () => storage.storage.get("closureRecovery")).toEqual({ attempts: 3, lastAttempt: now });
      vi.setSystemTime(now + 10_000);
      await coordinator.alarm();
      expect((await storage.storage.get<{ live: number }>("work"))?.live).toBe(now + 3_600_000);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      request.mockRestore();
      vi.useRealTimers();
      pair[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("settles an outstanding response recovered after a confirmed voice closure", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const original = new WebSocketPair();
    const recovered = new WebSocketPair();
    original[0].accept();
    recovered[0].accept();
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "provider-drain" }, transport: { sdp: "answer" } }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: original[1] }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: recovered[1] }));
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      const response = { id: "outstanding" };
      original[0].send(JSON.stringify({ type: "response.event", event: { type: "response.created", response } }));
      await expect.poll(async () => (await readState(env.DB)).state.liveSessions[0].responseIds).toEqual([response.id]);
      await coordinator.end();
      original[0].send(JSON.stringify({ type: "session.closed", event_id: "voice-closed", usage: { seconds: 4 } }));
      await expect
        .poll(async (): Promise<boolean> => (await readState(env.DB)).state.liveSessions[0].providerClosed)
        .toBe(true);
      vi.setSystemTime(Date.now() + 10_000);
      await coordinator.alarm();
      expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
      let state = (await readState(env.DB)).state;
      expect(state.liveSessions[0].accountingGap).not.toBe(true);
      expect(calculateReservationHold(state.reservations[0])).toBeGreaterThan(0);
      vi.setSystemTime(Date.now() + 1000);
      await coordinator.alarm();
      expect(request).toHaveBeenCalledTimes(3);
      recovered[0].send(
        JSON.stringify({
          type: "response.event",
          event_id: "response-final",
          event: {
            type: "response.completed",
            response: { ...response, usage: { input_tokens: 100, output_tokens: 50 } },
          },
        }),
      );
      await expect
        .poll(async (): Promise<boolean> => (await readState(env.DB)).state.reservations[0].settled)
        .toBe(true);
      state = (await readState(env.DB)).state;
      expect(state.liveSessions[0].accountingGap).not.toBe(true);
      expect(calculateReservationHold(state.reservations[0])).toBe(0);
    } finally {
      request.mockRestore();
      vi.useRealTimers();
      original[0].close();
      recovered[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});

it("keeps a drain alarm when reattachment completes after the call finishes", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const context = { userId: "reviewer", callId: id };
  const stub = env.CALLS.get(env.CALLS.idFromName(id));

  await runInDurableObject(stub, async (_instance, storage): Promise<void> => {
    const original = new WebSocketPair();
    const recovered = new WebSocketPair();
    original[0].accept();
    recovered[0].accept();
    let resolveRecovery: (response: Response) => void = () => {};
    const delayed = new Promise<Response>((resolve): void => {
      resolveRecovery = resolve;
    });
    const request = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ session: { id: "provider-slow" }, transport: { sdp: "answer" } }))
      .mockResolvedValueOnce(new Response(null, { status: 101, webSocket: original[1] }))
      .mockImplementationOnce((): Promise<Response> => delayed);
    vi.useFakeTimers({ toFake: ["Date"] });

    try {
      const coordinator = new LiveCall(storage, { ...env, VOICE_PROVIDER: "openai", OPENAI_API_KEY: "test-key" });
      await coordinator.start(context, "offer");
      original[0].close(1011, "transport lost");
      await expect.poll((): number => request.mock.calls.length, { timeout: 1000, interval: 20 }).toBe(3);
      await expect.poll(async (): Promise<string> => (await queryLiveStatus(env.DB, context)).state).toBe("ending");
      vi.setSystemTime(Date.now() + 11_000);
      await coordinator.alarm();
      expect((await queryLiveStatus(env.DB, context)).state).toBe("ended");
      const now = Date.now();
      resolveRecovery(new Response(null, { status: 101, webSocket: recovered[1] }));
      await expect.poll(async () => (await storage.storage.get<{ live: number }>("work"))?.live).toBe(now + 10_000);
    } finally {
      request.mockRestore();
      vi.useRealTimers();
      original[0].close();
      recovered[0].close();
      await storage.storage.deleteAlarm();
      await storage.storage.deleteAll();
    }
  });
});
