import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { queryDashboardPage, queryDashboardVersion } from "@voice-freight/backend/reporting";
import { summarizeCalls } from "@voice-freight/contracts/reporting";
import { callsSchema } from "@voice-freight/contracts/calls";
import { seedDatabase } from "@voice-freight/backend/seeding";
import records from "../../web/data/calls.json";

beforeEach(async (): Promise<void> => {
  await env.DB.prepare("DELETE FROM calls").run();
  await env.DB.prepare("DELETE FROM analysis").run();
});

it("pages mixed samples and private calls while aggregating authorized calls", async (): Promise<void> => {
  await seedDatabase(env.DB);
  const calls = callsSchema
    .parse(records)
    .slice(0, 3)
    .map((call) => ({ ...call, source: "Live" as const }));

  await env.DB.batch(
    calls.map((call, index) =>
      env.DB.prepare("INSERT INTO calls (id, data) VALUES (?, ?)").bind(
        call.id,
        JSON.stringify({
          id: call.id,
          ownerId: index === 2 ? "reviewer-two" : "reviewer",
          inventoryIds: [],
          record: call,
          finalSnapshot: null,
        }),
      ),
    ),
  );

  const samples = [{ id: "sample", startedAt: calls[0].startedAt }];
  const result = await queryDashboardPage(env.DB, "reviewer", 1, samples);
  expect(result.count).toBe(3);
  expect(result.sampleIds).toEqual(["sample"]);
  expect(result.calls.map((call) => call.id).sort()).toEqual(
    calls
      .slice(0, 2)
      .map((call) => call.id)
      .sort(),
  );
  expect(result.calls.every((call) => call.transcript.entries.length === 0)).toBe(true);
  expect(result.report).toEqual(summarizeCalls(calls.slice(0, 2)));
  expect(
    (
      await queryDashboardVersion(
        env.DB,
        "reviewer",
        result.pending.map((entry) => entry.id),
      )
    ).version,
  ).toBe(result.version);
  expect((await queryDashboardPage(env.DB, "administrator", 99, samples)).page).toBe(1);
});

it("keeps sample positions and aggregates stable across page boundaries", async (): Promise<void> => {
  await seedDatabase(env.DB);
  const calls = callsSchema.parse(records).map((call) => ({ ...call, source: "Live" as const }));
  await env.DB.batch(
    calls.map((call) =>
      env.DB.prepare("INSERT INTO calls (id, data) VALUES (?, ?)").bind(
        call.id,
        JSON.stringify({
          id: call.id,
          ownerId: "reviewer",
          inventoryIds: [],
          record: call,
          finalSnapshot: null,
        }),
      ),
    ),
  );
  const samples = [
    { id: "sample-first", startedAt: calls[2].startedAt },
    { id: "sample-second", startedAt: calls[2].startedAt },
    { id: "sample-last", startedAt: calls[6].startedAt },
  ];
  const expected = [
    ...samples.map((sample) => ({ ...sample, sample: true })),
    ...calls.map((call) => ({ ...call, sample: false })),
  ].sort(
    (a, b) => b.startedAt.localeCompare(a.startedAt) || Number(b.sample) - Number(a.sample) || a.id.localeCompare(b.id),
  );

  for (let page = 1; page <= 3; page++) {
    const result = await queryDashboardPage(env.DB, "reviewer", page, samples);
    const selected = expected.slice((page - 1) * 5, page * 5);
    expect(result.calls.map((call) => call.id).sort()).toEqual(
      selected
        .filter((entry) => !entry.sample)
        .map((entry) => entry.id)
        .sort(),
    );
    expect(result.sampleIds.sort()).toEqual(
      selected
        .filter((entry) => entry.sample)
        .map((entry) => entry.id)
        .sort(),
    );
    expect(result.report).toEqual(summarizeCalls(calls));
  }
});

it("tracks pending records and checks ownership on status reads", async (): Promise<void> => {
  await seedDatabase(env.DB);
  const call = callsSchema.parse(records)[0];
  await env.DB.prepare("INSERT INTO calls (id, data) VALUES (?, ?)")
    .bind(
      call.id,
      JSON.stringify({
        id: call.id,
        ownerId: "reviewer",
        inventoryIds: [],
        record: call,
        finalSnapshot: null,
      }),
    )
    .run();
  await env.DB.prepare("INSERT INTO analysis (id, data) VALUES (?, ?)")
    .bind(
      call.id,
      JSON.stringify({
        id: call.id,
        callId: call.id,
        status: "pending",
        version: 1,
      }),
    )
    .run();
  const dashboard = await queryDashboardPage(env.DB, "reviewer", 1, []);
  expect(dashboard.pending.map((entry) => entry.id)).toEqual([call.id]);
  expect((await queryDashboardVersion(env.DB, "reviewer", [call.id])).version).toEqual(dashboard.version);
  expect((await queryDashboardVersion(env.DB, "reviewer-two", [call.id])).version).not.toEqual(dashboard.version);
  const next = { ...callsSchema.parse(records)[1], endedAt: null };
  await env.DB.prepare("INSERT INTO calls (id, data) VALUES (?, ?)")
    .bind(
      next.id,
      JSON.stringify({ id: next.id, ownerId: "reviewer", inventoryIds: [], record: next, finalSnapshot: null }),
    )
    .run();
  expect((await queryDashboardVersion(env.DB, "reviewer", [call.id])).version).not.toEqual(dashboard.version);
  await env.DB.prepare("DELETE FROM calls WHERE id = ?").bind(next.id).run();
  await env.DB.prepare("UPDATE analysis SET data = ? WHERE id = ?")
    .bind(
      JSON.stringify({
        id: call.id,
        callId: call.id,
        status: "complete",
        version: 1,
        result: { status: "complete", sentiment: "Neutral", summary: "Done" },
      }),
      call.id,
    )
    .run();
  expect((await queryDashboardVersion(env.DB, "reviewer", [call.id])).version).not.toEqual(dashboard.version);
});

it("continues tracking a legacy pending call without an analysis row", async (): Promise<void> => {
  await seedDatabase(env.DB);
  const original = callsSchema.parse(records)[0];
  const call = { ...original, analysis: { status: "pending", sentiment: "Unknown", summary: null } };
  const data = { id: call.id, ownerId: "reviewer", inventoryIds: [], record: call, finalSnapshot: null };
  await env.DB.prepare("INSERT INTO calls (id, data) VALUES (?, ?)").bind(call.id, JSON.stringify(data)).run();

  const dashboard = await queryDashboardPage(env.DB, "reviewer", 1, []);
  expect(dashboard.pending.map((entry) => entry.id)).toEqual([call.id]);
  expect((await queryDashboardVersion(env.DB, "reviewer", [call.id])).version).toEqual(dashboard.version);

  const updated = {
    ...data,
    record: { ...call, analysis: { status: "complete", sentiment: "Neutral", summary: "Done" } },
  };
  await env.DB.prepare("UPDATE calls SET data = ? WHERE id = ?").bind(JSON.stringify(updated), call.id).run();
  expect((await queryDashboardVersion(env.DB, "reviewer", [call.id])).version).not.toEqual(dashboard.version);
});
