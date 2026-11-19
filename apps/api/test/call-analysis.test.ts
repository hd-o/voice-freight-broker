import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { createCall, finalizeCall } from "@voice-freight/backend/calls";
import { queryCall } from "@voice-freight/backend/reporting";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB);
});

it("returns the same analysis as call details with call access checks", async (): Promise<void> => {
  const { id } = await createCall(env.DB, "reviewer");
  const origin = "http://localhost";
  const session = await SELF.fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "reviewer" }),
  });
  const cookie = session.headers.get("Set-Cookie")!;
  const request = (): Promise<Response> =>
    SELF.fetch(`${origin}/api/calls/${id}/analysis`, { headers: { Cookie: cookie } });

  expect(await (await request()).json()).toEqual(
    (await queryCall(env.DB, { userId: "reviewer", callId: id })).analysis,
  );
  await finalizeCall(
    env.DB,
    { userId: "reviewer", callId: id },
    { connection: "Interrupted", transcriptComplete: false },
  );
  await transact(env.DB, (state): void => {
    state.analysis[0].reason = "allowance";
    state.analysis[0].nextAttemptAt = "2026-12-01T00:00:00.000Z";
  });
  expect(await (await request()).json()).toEqual(
    (await queryCall(env.DB, { userId: "reviewer", callId: id })).analysis,
  );
  await transact(env.DB, (state): void => {
    state.analysis[0].status = "complete";
    state.analysis[0].result = { status: "complete", sentiment: "Neutral", summary: "Finished" };
  });
  expect(await (await request()).json()).toEqual(
    (await queryCall(env.DB, { userId: "reviewer", callId: id })).analysis,
  );

  const other = await SELF.fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "reviewer-two" }),
  });
  const denied = await SELF.fetch(`${origin}/api/calls/${id}/analysis`, {
    headers: { Cookie: other.headers.get("Set-Cookie")! },
  });
  expect(denied.status).toBe(404);
});
