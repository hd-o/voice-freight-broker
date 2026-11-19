import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, new Date().toISOString());
});

afterEach((): void => {
  vi.useRealTimers();
});

it("schedules the next watchdog and the inactivity warning deadline", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());
  const stub = env.CALLS.get(env.CALLS.idFromName(id));
  await stub.start({ userId: "reviewer", callId: id }, "stub-offer");

  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.now();
  await transact(env.DB, (state): void => {
    const session = state.liveSessions.find((entry): boolean => entry.id === id)!;
    session.lastInputAt = new Date(now - 85_000).toISOString();
  });

  try {
    const initial = await runInDurableObject(stub, (_instance, context): Promise<number | null> =>
      context.storage.getAlarm(),
    );
    expect(initial).not.toBeNull();
    vi.setSystemTime(initial!);
    await runDurableObjectAlarm(stub);

    const deadline = await runInDurableObject(stub, (_instance, context): Promise<number | null> =>
      context.storage.getAlarm(),
    );
    expect(deadline).toBe(now + 5_000);
    vi.setSystemTime(deadline!);
    await runDurableObjectAlarm(stub);

    const { state } = await readState(env.DB);
    expect(state.liveSessions.find((entry): boolean => entry.id === id)?.notice).toContain("30 seconds");

    const next = await runInDurableObject(stub, (_instance, context): Promise<number | null> =>
      context.storage.getAlarm(),
    );
    expect(next).toBe(now + 35_000);
  } finally {
    vi.useRealTimers();
    await stub.end();
    await runInDurableObject(stub, async (_instance, context): Promise<void> => {
      await context.storage.deleteAlarm();
      await context.storage.deleteAll();
    });
  }
});
