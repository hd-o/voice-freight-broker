import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { ingestProviderEvent } from "@voice-freight/backend/provider-events";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";

const clock = "2026-11-30T23:59:50.000Z";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

it("preserves concurrent calls and legacy usage while applying scoped provider events", async (): Promise<void> => {
  const first = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID(), clock);
  const second = await reserveLiveCall(env.DB, "reviewer-two", crypto.randomUUID(), clock);
  const firstContext = { userId: "reviewer", callId: first.id };
  const secondContext = { userId: "reviewer-two", callId: second.id };
  const event = { type: "session.usage.updated", event_id: "voice", usage: { seconds: 12 } };

  await ingestProviderEvent(env.DB, firstContext, event, "2026-12-01T00:00:02.000Z");
  await transact(env.DB, (state): void => {
    delete state.reservations.find((reservation): boolean => reservation.id === first.id)!.callSpending;
  });

  await Promise.all([
    ingestProviderEvent(env.DB, firstContext, { ...event, event_id: "voice-2", usage: { seconds: 15 } }),
    ingestProviderEvent(env.DB, secondContext, { ...event, event_id: "second-voice" }),
  ]);

  expect(await ingestProviderEvent(env.DB, firstContext, event)).toBe(false);
  const { state, version } = await readState(env.DB);
  const firstReservation = state.reservations.find((reservation): boolean => reservation.id === first.id)!;
  const secondReservation = state.reservations.find((reservation): boolean => reservation.id === second.id)!;
  expect(firstReservation.chargedMicrodollars).toBe(12501);
  expect(firstReservation.callSpending?.voiceChargedMicrodollars).toBe(12501);
  expect(secondReservation.chargedMicrodollars).toBe(10001);
  expect(state.spendingPeriods).toEqual(
    expect.arrayContaining([
      { id: "2026-11", spentMicrodollars: 16668 },
      { id: "2026-12", spentMicrodollars: 5834 },
    ]),
  );

  expect(
    await ingestProviderEvent(env.DB, firstContext, {
      type: "response.event",
      event_id: "partial",
      event: { type: "response.output_text.delta", delta: "partial" },
    }),
  ).toBe(false);
  expect((await readState(env.DB)).version).toBe(version);
});
