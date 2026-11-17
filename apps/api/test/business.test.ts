import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { seedDatabase, restockInventory } from "@voice-freight/backend/seeding";
import { createCall, finalizeCall } from "@voice-freight/backend/calls";
import { executeTool } from "@voice-freight/backend/business";
import { recordEvidence } from "@voice-freight/backend/evidence";
import { queryDashboard, queryCall } from "@voice-freight/backend/reporting";
import { readState, transact } from "@voice-freight/backend/repository";
import { checkLocalAuthentication } from "@voice-freight/backend/identity";
import type { CallContext, ToolName } from "@voice-freight/contracts/business";

const clock = "2026-11-13T12:00:00.000Z";
const firstLoad = "seed-v1-01";
type QuoteResult = {
  quoteId: string;
  rateCents: number;
  usedRounds: number;
  remainingRounds: number;
  decision?: string;
};
type AgreementResult = {
  agreementId: string;
  rateCents: number;
  version: number;
};

beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB, clock);
});

async function openCall(userId = "reviewer", mcNumber = "123456"): Promise<CallContext> {
  const { id } = await createCall(env.DB, userId, clock);
  const context = { userId, callId: id };
  await invoke(context, "verify_carrier", { mcNumber });
  return context;
}
async function invoke(
  context: CallContext,
  name: ToolName,
  argumentsData: unknown,
  invocationId = crypto.randomUUID(),
): ReturnType<typeof executeTool> {
  return executeTool(env.DB, context, name, { invocationId, arguments: argumentsData }, clock);
}
async function select(context: CallContext, loadId = firstLoad): Promise<QuoteResult> {
  return (await invoke(context, "select_load", { loadId })) as QuoteResult;
}
async function offer(context: CallContext, quote: QuoteResult, amountCents: number): Promise<QuoteResult> {
  return (await invoke(context, "evaluate_offer", {
    quoteId: quote.quoteId,
    amountCents,
  })) as QuoteResult;
}
async function recordConfirmation(
  context: CallContext,
  targetId: string,
  action: "handoff" | "cancel" = "handoff",
  confirmed = true,
): Promise<{ readbackId: string; callerId: string }> {
  const readbackId = crypto.randomUUID();
  const callerId = crypto.randomUUID();

  await recordEvidence(
    env.DB,
    context,
    {
      id: readbackId,
      speaker: "broker",
      text: "Carrier, load and exact rate read-back",
      offsetSeconds: 10,
      action,
      targetId,
      confirmed: false,
    },
    clock,
  );

  await recordEvidence(
    env.DB,
    context,
    {
      id: callerId,
      speaker: "carrier",
      text: confirmed ? "Yes, confirmed." : "Maybe.",
      offsetSeconds: 11,
      action,
      targetId,
      readbackId,
      confirmed,
    },
    clock,
  );

  return { readbackId, callerId };
}
async function confirm(context: CallContext, quote: QuoteResult): Promise<AgreementResult> {
  const evidence = await recordConfirmation(context, quote.quoteId);

  return (await invoke(context, "confirm_handoff", {
    quoteId: quote.quoteId,
    evidence,
  })) as AgreementResult;
}
async function request(path: string, method = "GET", body?: unknown, cookie?: string): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    method,
    headers: {
      Origin: "http://localhost",
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function authenticate(userId: string): Promise<string> {
  const response = await request("/api/session", "POST", { userId });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")!.split(";")[0];
}

it("allows corrections before binding and rejects carrier switches without changing state", async (): Promise<void> => {
  const { id } = await createCall(env.DB, "reviewer", clock);
  const context = { userId: "reviewer", callId: id };

  for (const [mcNumber, status] of [
    ["999999", "not_found"],
    ["345678", "ineligible"],
    ["456789", "unavailable"],
    ["567890", "unavailable"],
    ["123456", "eligible"],
  ]) {
    expect(await invoke(context, "verify_carrier", { mcNumber })).toMatchObject({
      status,
      source: "fixture",
      fixtureVersion: "carriers-v1",
    });
  }

  const quote = await select(context);
  const evidence = await recordConfirmation(context, quote.quoteId);
  const before = (await readState(env.DB)).state;
  const switchId = crypto.randomUUID();

  await expect(invoke(context, "verify_carrier", { mcNumber: "234567" }, switchId)).rejects.toMatchObject({
    code: "carrier_bound",
  });

  expect((await readState(env.DB)).state).toEqual({
    ...before,
    receipts: [
      ...before.receipts,
      expect.objectContaining({
        id: `${context.callId}:${switchId}`,
        error: {
          code: "carrier_bound",
          message: expect.any(String),
          status: 409,
        },
      }),
    ],
  });

  await invoke(context, "verify_carrier", { mcNumber: "123456" });

  expect(
    await invoke(context, "confirm_handoff", {
      quoteId: quote.quoteId,
      evidence,
    }),
  ).toMatchObject({ rateCents: 200000 });
});

it("persists three distinct prices across reviewers/calls, repeats, and exhausted quote acceptance", async (): Promise<void> => {
  const context = await openCall();
  let quote = await select(context);
  const initialQuote = quote;
  quote = await offer(context, quote, 250000);
  expect(quote).toMatchObject({ rateCents: 210000, usedRounds: 1 });
  const invocationId = crypto.randomUUID();
  const args = { quoteId: quote.quoteId, amountCents: 260000 };
  quote = (await invoke(context, "evaluate_offer", args, invocationId)) as QuoteResult;
  expect(quote).toMatchObject({ rateCents: 215000, usedRounds: 2 });
  expect(await invoke(context, "evaluate_offer", args, invocationId)).toEqual(quote);
  const repeated = await offer(context, quote, 250000);
  expect(repeated).toMatchObject({ ...quote, decision: "repeated_price" });

  await expect(offer(context, initialQuote, 270000)).rejects.toMatchObject({
    code: "stale_quote",
  });

  await finalizeCall(
    env.DB,
    context,
    { connection: "Ended normally", transcriptComplete: true },
    "2026-11-13T12:01:00.000Z",
  );

  const returning = await openCall("reviewer-two");
  quote = await select(returning);
  expect(quote).toMatchObject({ rateCents: 215000, remainingRounds: 1 });
  quote = await offer(returning, quote, 270000);

  expect(quote).toMatchObject({
    decision: "bargaining_exhausted",
    rateCents: 215000,
    usedRounds: 3,
  });

  expect(await offer(returning, quote, 210000)).toMatchObject({
    decision: "bargaining_exhausted",
    usedRounds: 3,
    rateCents: 215000,
  });

  quote = await select(returning);
  expect(await confirm(returning, quote)).toMatchObject({ rateCents: 215000 });
  expect((await readState(env.DB)).state.negotiations[0].prices).toEqual([250000, 260000, 270000]);
});

it("accepts allowed prices and permits multiple agreements with immutable finalization and pending analysis", async (): Promise<void> => {
  const context = await openCall();
  const quote = await offer(context, await select(context), 219999);

  expect(quote).toMatchObject({
    decision: "price_allowed",
    usedRounds: 1,
    rateCents: 219999,
  });

  await confirm(context, quote);
  await confirm(context, await select(context, "seed-v1-02"));
  const pending = await select(context, "seed-v1-03");
  const evidence = await recordConfirmation(context, pending.quoteId);

  const ended = await finalizeCall(
    env.DB,
    context,
    { connection: "Interrupted", transcriptComplete: false },
    "2026-11-13T12:02:00.000Z",
  );

  expect(ended.agreements).toHaveLength(2);

  expect((await queryDashboard(env.DB, "reviewer")).report).toMatchObject({
    finalAgreementCount: 2,
    agreementRate: 1,
  });

  expect(
    await finalizeCall(env.DB, context, {
      connection: "Ended normally",
      transcriptComplete: true,
    }),
  ).toEqual(ended);

  expect((await readState(env.DB)).state.analysis).toMatchObject([
    { callId: context.callId, status: "pending", publication: "pending" },
  ]);

  await expect(invoke(context, "select_load", { loadId: firstLoad })).rejects.toMatchObject({ code: "call_ended" });
  const confirmationId = crypto.randomUUID();

  await expect(
    invoke(context, "confirm_handoff", { quoteId: pending.quoteId, evidence }, confirmationId),
  ).rejects.toMatchObject({ code: "call_ended" });

  const beforeReplay = (await readState(env.DB)).state;

  await expect(
    invoke(context, "confirm_handoff", { quoteId: pending.quoteId, evidence }, confirmationId),
  ).rejects.toMatchObject({ code: "call_ended" });

  expect((await readState(env.DB)).state).toEqual(beforeReplay);
});

it("atomically resolves competing inventory claims, replays, and confirmed cancellation releases availability", async (): Promise<void> => {
  const first = await openCall();
  const second = await openCall("reviewer-two", "234567");
  const quoteA = await select(first);
  const quoteB = await select(second);
  const evidenceA = await recordConfirmation(first, quoteA.quoteId);
  const evidenceB = await recordConfirmation(second, quoteB.quoteId);
  const idA = crypto.randomUUID();
  const idB = crypto.randomUUID();

  const results = await Promise.allSettled([
    invoke(first, "confirm_handoff", { quoteId: quoteA.quoteId, evidence: evidenceA }, idA),
    invoke(second, "confirm_handoff", { quoteId: quoteB.quoteId, evidence: evidenceB }, idB),
  ]);

  expect(results.filter((result): boolean => result.status === "fulfilled")).toHaveLength(1);
  expect((await readState(env.DB)).state.agreements).toHaveLength(1);
  const winnerIndex = results[0].status === "fulfilled" ? 0 : 1;
  const winner = winnerIndex === 0 ? first : second;
  const loser = winnerIndex === 0 ? second : first;
  const winnerQuote = winnerIndex === 0 ? quoteA : quoteB;
  const winnerEvidence = winnerIndex === 0 ? evidenceA : evidenceB;
  const loserQuote = winnerIndex === 0 ? quoteB : quoteA;
  const loserEvidence = winnerIndex === 0 ? evidenceB : evidenceA;
  const loserId = winnerIndex === 0 ? idB : idA;
  const agreement = (results[winnerIndex] as PromiseFulfilledResult<AgreementResult>).value;

  expect(
    await invoke(
      winner,
      "confirm_handoff",
      { quoteId: winnerQuote.quoteId, evidence: winnerEvidence },
      winnerIndex === 0 ? idA : idB,
    ),
  ).toEqual(agreement);

  expect(await invoke(loser, "search_loads", { reference: "NS-seed-v1-01" })).toEqual({ loads: [] });
  const evidence = await recordConfirmation(winner, agreement.agreementId, "cancel");
  const cancellationId = crypto.randomUUID();

  const cancellation = await invoke(
    winner,
    "cancel_agreement",
    { agreementId: agreement.agreementId, evidence },
    cancellationId,
  );

  expect(
    await invoke(winner, "cancel_agreement", { agreementId: agreement.agreementId, evidence }, cancellationId),
  ).toEqual(cancellation);

  expect(await invoke(loser, "search_loads", { reference: "NS-seed-v1-01" })).toMatchObject({
    loads: [{ id: firstLoad }],
  });

  const beforeReplay = (await readState(env.DB)).state;
  const failures = beforeReplay.receipts.filter((receipt): boolean => receipt.id === `${loser.callId}:${loserId}`);
  expect(failures).toMatchObject([{ error: { code: "load_unavailable", status: 409 } }]);
  const failure = failures[0];

  if (!("error" in failure)) {
    throw new Error("Missing rejected confirmation");
  }

  await expect(
    invoke(loser, "confirm_handoff", { quoteId: loserQuote.quoteId, evidence: loserEvidence }, loserId),
  ).rejects.toMatchObject(failure.error);

  expect((await readState(env.DB)).state).toEqual(beforeReplay);
  await confirm(loser, await select(loser));
});

it("keeps an allocation during renegotiation and rolls back failed or stale replacement evidence", async (): Promise<void> => {
  const context = await openCall();
  const original = await confirm(context, await select(context));

  let replacement = (await invoke(context, "begin_renegotiation", {
    agreementId: original.agreementId,
  })) as QuoteResult;

  replacement = await offer(context, replacement, 210000);
  const ambiguous = await recordConfirmation(context, replacement.quoteId, "handoff", false);
  const before = (await readState(env.DB)).state;
  const confirmationId = crypto.randomUUID();

  await expect(
    invoke(context, "confirm_handoff", { quoteId: replacement.quoteId, evidence: ambiguous }, confirmationId),
  ).rejects.toMatchObject({ code: "evidence_required" });

  expect((await readState(env.DB)).state).toEqual({
    ...before,
    receipts: [
      ...before.receipts,
      expect.objectContaining({
        id: `${context.callId}:${confirmationId}`,
        error: {
          code: "evidence_required",
          message: expect.any(String),
          status: 409,
        },
      }),
    ],
  });

  const other = await openCall("reviewer-two", "234567");

  await expect(select(other)).rejects.toMatchObject({
    code: "load_unavailable",
  });

  const updated = await confirm(context, replacement);
  expect(updated).toMatchObject({ version: 2, rateCents: 210000 });
  const call = await queryCall(env.DB, context);
  expect(call.agreements.map((entry): typeof entry.status => entry.status)).toEqual(["superseded", "effective"]);
  expect((await queryDashboard(env.DB, "reviewer")).report.finalAgreementCount).toBe(0);

  await invoke(context, "begin_renegotiation", {
    agreementId: updated.agreementId,
  });

  const final = await finalizeCall(
    env.DB,
    context,
    { connection: "Ended normally", transcriptComplete: true },
    "2026-11-13T12:01:00.000Z",
  );

  expect(final.agreements.filter((entry): boolean => entry.status === "effective")).toMatchObject([
    { rateCents: 210000 },
  ]);

  await expect(
    invoke(context, "cancel_agreement", {
      agreementId: updated.agreementId,
      evidence: ambiguous,
    }),
  ).rejects.toMatchObject({ code: "call_ended" });
});

it("invalidates load changes and shared versions while preserving state on rejected ownership and late evidence", async (): Promise<void> => {
  const first = await openCall();
  const quote = await select(first);
  const evidence = await recordConfirmation(first, quote.quoteId);
  const second = await openCall("reviewer-two");
  await offer(second, await select(second), 250000);

  await expect(invoke(first, "confirm_handoff", { quoteId: quote.quoteId, evidence })).rejects.toMatchObject({
    code: "stale_quote",
  });

  const fresh = await select(first);
  const freshEvidence = await recordConfirmation(first, fresh.quoteId);
  await select(first, "seed-v1-02");

  await expect(
    invoke(first, "confirm_handoff", {
      quoteId: fresh.quoteId,
      evidence: freshEvidence,
    }),
  ).rejects.toMatchObject({ code: "stale_quote" });

  const before = (await readState(env.DB)).state;

  await expect(
    invoke({ ...first, userId: "reviewer-two" }, "verify_carrier", {
      mcNumber: "234567",
    }),
  ).rejects.toMatchObject({ code: "call_unavailable" });

  expect((await readState(env.DB)).state).toEqual(before);

  expect((await queryDashboard(env.DB, "reviewer-two")).calls.map((call): typeof call.id => call.id)).toEqual([
    second.callId,
  ]);

  expect((await queryDashboard(env.DB, "administrator")).calls).toHaveLength(2);
});

it("restocks additively and repeatably with fixed membership and current fixture dates", async (): Promise<void> => {
  const context = await openCall();
  const quote = await offer(context, await select(context), 250000);
  const id = crypto.randomUUID();
  await expect(restockInventory(env.DB, "reviewer", id, clock)).rejects.toMatchObject({ code: "forbidden" });
  expect(await restockInventory(env.DB, "administrator", id, clock)).toMatchObject({ added: 20 });
  expect(await restockInventory(env.DB, "administrator", id, clock)).toMatchObject({ added: 0 });
  expect(await seedDatabase(env.DB, clock)).toMatchObject({ added: 0 });
  const { state } = await readState(env.DB);
  expect(state.inventory).toHaveLength(40);
  expect(state.calls[0].inventoryIds).toHaveLength(20);
  expect(state.negotiations[0].prices).toEqual([250000]);

  expect(
    state.inventory.every(
      (entry): boolean => entry.load.pickupAt > clock && entry.load.deliveryAt > entry.load.pickupAt,
    ),
  ).toBe(true);

  await expect(select(context, `stock-${id}-01`)).rejects.toMatchObject({
    code: "load_unavailable",
  });

  const later = await openCall("reviewer-two");

  expect(await select(later, `stock-${id}-01`)).toMatchObject({
    usedRounds: 0,
  });

  expect(await select(context)).toMatchObject({
    rateCents: quote.rateCents,
    usedRounds: 1,
  });
});

it("uses equivalent REST and private RPC rules, validates arguments, origin, sessions, and deployed auth", async (): Promise<void> => {
  expect((): ReturnType<typeof checkLocalAuthentication> => checkLocalAuthentication("prod", "local")).toThrow(
    "disabled",
  );

  expect((await request("/api/dashboard")).status).toBe(401);
  const cookie = await authenticate("reviewer");
  const created = await request("/api/calls", "POST", {}, cookie);
  expect(created.status).toBe(201);
  const { id } = await created.json<{ id: string }>();
  const context = { userId: "reviewer", callId: id };

  const refusal = {
    invocationId: crypto.randomUUID(),
    arguments: { loadId: firstLoad },
  };

  const refused = await request(`/api/calls/${id}/tools/select_load`, "POST", refusal, cookie);
  expect(refused.status).toBe(409);
  const failure = await refused.json();
  expect(failure).toMatchObject({ error: { code: "verification_required" } });

  const invocation = {
    invocationId: crypto.randomUUID(),
    arguments: { mcNumber: "123456" },
  };

  const rest = await request(`/api/calls/${id}/tools/verify_carrier`, "POST", invocation, cookie);
  expect(rest.status).toBe(200);
  expect(await env.TOOLS.verify_carrier(context, invocation)).toEqual(await rest.json());
  const beforeReplay = (await readState(env.DB)).state;
  expect(await env.TOOLS.select_load(context, refusal)).toEqual(failure);
  const replayed = await request(`/api/calls/${id}/tools/select_load`, "POST", refusal, cookie);
  expect(replayed.status).toBe(409);
  expect(await replayed.json()).toEqual(failure);
  expect((await readState(env.DB)).state).toEqual(beforeReplay);

  const conflict = {
    ...refusal,
    arguments: { loadId: "seed-v1-02" },
  };

  expect(await env.TOOLS.select_load(context, conflict)).toMatchObject({
    error: { code: "invocation_conflict" },
  });

  const conflicted = await request(`/api/calls/${id}/tools/select_load`, "POST", conflict, cookie);
  expect(conflicted.status).toBe(409);

  expect(await conflicted.json()).toMatchObject({
    error: { code: "invocation_conflict" },
  });

  expect((await readState(env.DB)).state).toEqual(beforeReplay);

  const selection = {
    invocationId: crypto.randomUUID(),
    arguments: { loadId: firstLoad },
  };

  const rpcQuote = await env.TOOLS.select_load(context, selection);
  const restQuote = await request(`/api/calls/${id}/tools/select_load`, "POST", selection, cookie);
  expect(await restQuote.json()).toEqual(rpcQuote);

  async function compareAdapters(name: ToolName, argumentsData: unknown): Promise<unknown> {
    const operation = {
      invocationId: crypto.randomUUID(),
      arguments: argumentsData,
    };

    const rpc = await env.TOOLS.execute(context, name, operation);
    const http = await request(`/api/calls/${id}/tools/${name}`, "POST", operation, cookie);
    expect(http.status).toBe(200);
    expect(await http.json()).toEqual(rpc);
    return rpc;
  }

  await compareAdapters("search_loads", {
    origin: "  DALLAS,   TX ",
    destination: "Atlanta",
    equipment: "dry van",
  });

  const quote = (await compareAdapters("evaluate_offer", {
    quoteId: (rpcQuote as QuoteResult).quoteId,
    amountCents: 210000,
  })) as QuoteResult;

  const evidence = await recordConfirmation(context, quote.quoteId);

  const agreement = (await compareAdapters("confirm_handoff", {
    quoteId: quote.quoteId,
    evidence,
  })) as AgreementResult;

  const replacement = (await compareAdapters("begin_renegotiation", {
    agreementId: agreement.agreementId,
  })) as QuoteResult;

  const updated = (await compareAdapters("confirm_handoff", {
    quoteId: replacement.quoteId,
    evidence: await recordConfirmation(context, replacement.quoteId),
  })) as AgreementResult;

  await compareAdapters("cancel_agreement", {
    agreementId: updated.agreementId,
    evidence: await recordConfirmation(context, updated.agreementId, "cancel"),
  });

  expect(
    (
      await request(
        `/api/calls/${id}/tools/select_load`,
        "POST",
        {
          invocationId: "bad",
          arguments: { loadId: firstLoad, userId: "administrator" },
        },
        cookie,
      )
    ).status,
  ).toBe(400);

  expect(
    await env.TOOLS.select_load(context, {
      invocationId: "bad",
      arguments: { loadId: firstLoad, userId: "administrator" },
    }),
  ).toMatchObject({ error: { code: "invalid_input" } });

  expect((await readState(env.DB)).state.receipts.some((receipt): boolean => receipt.id === `${id}:bad`)).toBe(false);
  const otherCookie = await authenticate("reviewer-two");
  expect((await request(`/api/calls/${id}`, "GET", undefined, otherCookie)).status).toBe(404);

  expect((await request("/api/inventory/restock", "POST", { operationId: crypto.randomUUID() }, cookie)).status).toBe(
    403,
  );

  const attack = await SELF.fetch("http://localhost/api/session", {
    method: "POST",
    headers: { Origin: "http://evil.test", "Content-Type": "application/json" },
    body: JSON.stringify({ userId: "administrator" }),
  });

  expect(attack.status).toBe(403);
  const dashboard = await request("/api/dashboard", "GET", undefined, cookie);
  expect(dashboard.headers.get("Cache-Control")).toBe("private, no-store");
  expect(JSON.stringify(await dashboard.json())).not.toMatch(/maximumCents|prices|fingerprint|readbackId/);
  expect((await request("/api/session", "DELETE", undefined, cookie)).status).toBe(200);
  expect((await request("/api/dashboard", "GET", undefined, cookie)).status).toBe(401);
});

it("matches city, state and combined locations consistently without selecting a load", async (): Promise<void> => {
  const context = await openCall();
  const memphis = await invoke(context, "search_loads", { origin: "Memphis" });
  expect(memphis).toMatchObject({
    loads: expect.arrayContaining([expect.objectContaining({ origin: "Memphis, TN" })]),
  });

  for (const origin of ["Tennessee", "TN", "  tEnNeSsEe  ", "Memphis Tennessee", "Memphis, TN", "MEMPHIS, T.N."]) {
    expect(await invoke(context, "search_loads", { origin })).toEqual(memphis);
  }

  expect(await invoke(context, "search_loads", { destination: "Colorado" })).toEqual(memphis);
  expect(await invoke(context, "search_loads", { destination: "Denver, CO" })).toEqual(memphis);

  expect(
    await invoke(context, "search_loads", {
      origin: "Tennessee",
      destination: "Colorado",
      equipment: "reefer",
      reference: "NS-seed-v1-07",
    }),
  ).toMatchObject({ loads: [expect.objectContaining({ id: "seed-v1-07" })] });

  for (const query of [
    { origin: "CA" },
    { origin: "LA" },
    { origin: "Tennessee", destination: "Texas" },
    { origin: "Memphis, TX" },
  ]) {
    expect(await invoke(context, "search_loads", query)).toEqual({ loads: [] });
  }

  const before = (await readState(env.DB)).state;
  expect(before.quotes).toHaveLength(0);
  expect(before.negotiations).toHaveLength(0);
  expect(before.calls.find((call): boolean => call.id === context.callId)?.selectedLoadId).toBeNull();

  const quote = await select(context, "seed-v1-07");
  await confirm(context, quote);
  const remaining = await invoke(context, "search_loads", { origin: "TN" });
  expect(remaining).toMatchObject({
    loads: expect.not.arrayContaining([expect.objectContaining({ id: "seed-v1-07" })]),
  });
  expect(await invoke(context, "search_loads", { origin: "Tennessee" })).toEqual(remaining);
});

it("matches multiword states and DC without confusing city substrings or another state's suffix", async (): Promise<void> => {
  await transact(env.DB, (state): void => {
    const original = state.inventory[0];

    for (const [index, origin] of ["Charleston, WV", "Richmond, VA", "Clinton, IA", "Washington, DC"].entries()) {
      const id = `regional-${index}`;
      state.inventory.push({
        ...structuredClone(original),
        id,
        load: { ...structuredClone(original.load), id, reference: id, origin },
      });
    }
  });

  const context = await openCall();

  for (const origin of ["West Virginia", "Charleston, West Virginia", "Charleston WV"]) {
    expect(await invoke(context, "search_loads", { origin })).toMatchObject({
      loads: [expect.objectContaining({ id: "regional-0" })],
    });
  }

  expect(await invoke(context, "search_loads", { origin: "Virginia" })).toMatchObject({
    loads: [expect.objectContaining({ id: "regional-1" })],
  });
  expect(await invoke(context, "search_loads", { origin: "IN" })).toEqual({ loads: [] });
  expect(await invoke(context, "search_loads", { origin: "District of Columbia" })).toEqual(
    await invoke(context, "search_loads", { origin: "D.C." }),
  );
});
