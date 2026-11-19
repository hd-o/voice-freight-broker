import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { reserveLiveCall } from "@voice-freight/backend/live";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB);
});

it("pages saved fragments by arrival sequence while preserving transcript order and access", async (): Promise<void> => {
  const { id } = await reserveLiveCall(env.DB, "reviewer", crypto.randomUUID());

  await transact(env.DB, (state): void => {
    state.transcriptFragments.push(
      { id: `${id}:a`, callId: id, sequence: 0, speaker: "carrier", startMs: 200, endMs: 300, text: "later" },
      { id: `${id}:b`, callId: id, sequence: 1, speaker: "broker", startMs: 0, endMs: 100, text: "earlier" },
    );
  });

  const signIn = await SELF.fetch("http://localhost/api/session", {
    method: "POST",
    headers: { Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "reviewer" }),
  });

  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  const path = `http://localhost/api/calls/${id}/transcript`;
  const request = (query = ""): Promise<Response> => SELF.fetch(`${path}${query}`, { headers: { Cookie: cookie } });
  const full = await (await request()).json<{ fragments: { text: string }[] }>();
  expect(full.fragments.map((fragment): string => fragment.text)).toEqual(["earlier", "later"]);
  expect(full).not.toHaveProperty("cursor");

  const first = await (await request("?after=-1")).json<{ fragments: { text: string }[]; cursor: number }>();
  expect(first.fragments.map((fragment): string => fragment.text)).toEqual(["earlier", "later"]);
  expect(first.cursor).toBe(1);
  expect(await (await request("?after=0")).json()).toMatchObject({
    fragments: [{ text: "earlier" }],
    cursor: 1,
  });
  expect(await (await request("?after=1")).json()).toEqual({ fragments: [], cursor: 1 });
  expect((await request("?after=-2")).status).toBe(400);
  expect((await request("?after=1.2")).status).toBe(400);
  expect((await SELF.fetch(`${path}?after=-1`)).status).toBe(401);
});
