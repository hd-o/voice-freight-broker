import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { readState, transact } from "@voice-freight/backend/repository";
import { seedDatabase } from "@voice-freight/backend/seeding";
import { queryAccessIdentity } from "@voice-freight/backend/access";
import { calculateAvailableMicrodollars } from "@voice-freight/backend/spending";
import api from "../src/worker";
import application from "../../web/deploy/worker";

const issuer = "https://access-tests.cloudflareaccess.com";
const origin = "https://demo.example.test";
const audience = "test-application";
const configuration = {
  ...env,
  ENVIRONMENT: "prod",
  AUTH_MODE: "access",
  ACCESS_ISSUER: issuer,
  ACCESS_AUDIENCE: audience,
  PUBLIC_ORIGIN: origin,
};
const administrator = { id: "access:admin@example.test", name: "Admin", role: "administrator" } as const;
const reviewer = { id: "access:reviewer@example.test", name: "Reviewer", role: "reviewer" } as const;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async (): Promise<void> => {
  keys = await generateKeyPair("RS256", { extractable: true });
});
beforeEach(async (): Promise<void> => {
  const { state } = await readState(env.DB);
  await env.DB.batch(Object.keys(state).map((name): D1PreparedStatement => env.DB.prepare(`DELETE FROM ${name}`)));
  await seedDatabase(env.DB);
  await transact(env.DB, (state): void => {
    state.users.push(administrator, reviewer);
  });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input): Promise<Response> => {
    expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe(
      `${issuer}/cdn-cgi/access/certs`,
    );
    return Response.json({ keys: [jwk] });
  });
});
afterEach((): void => {
  vi.restoreAllMocks();
});

async function signToken(
  email = "reviewer@example.test",
  overrides: { issuer?: string; audience?: string; expiration?: number; type?: string } = {},
): Promise<string> {
  return new SignJWT({ email, type: overrides.type ?? "app" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject("verified-subject")
    .setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? audience)
    .setExpirationTime(overrides.expiration ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(keys.privateKey);
}

async function requestApi(
  path: string,
  token?: string,
  method = "GET",
  body?: unknown,
  requestOrigin = origin,
): Promise<Response> {
  const context = createExecutionContext();
  const response = await api.fetch(
    new Request(`${requestOrigin}${path}`, {
      method,
      headers: {
        Origin: requestOrigin,
        ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    configuration,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

it("rejects missing, forged, expired, wrong-issuer and wrong-audience credentials", async (): Promise<void> => {
  const token = await signToken();

  for (const candidate of [
    undefined,
    "forged",
    token.slice(0, -20) + "AAAAAAAAAAAAAAAAAAAA",
    await signToken(undefined, { expiration: 1 }),
    await signToken(undefined, { issuer: "https://other.cloudflareaccess.com" }),
    await signToken(undefined, { audience: "another-app" }),
    await signToken(undefined, { type: "service" }),
  ]) {
    expect((await requestApi("/api/dashboard", candidate)).status).toBe(401);
  }

  const response = await requestApi("/api/identity", token);
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ user: reviewer, identities: [] });
});

it("uses persisted roles, rejects uninvited users, and hides local account endpoints", async (): Promise<void> => {
  const token = await signToken();
  expect((await requestApi("/api/identity", await signToken("stranger@example.test"))).status).toBe(403);
  expect((await requestApi("/api/inventory/restock", token, "POST", { operationId: crypto.randomUUID() })).status).toBe(
    403,
  );
  expect(
    (
      await requestApi("/api/inventory/restock", await signToken("admin@example.test"), "POST", {
        operationId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(200);
  expect((await requestApi("/api/session", token, "POST", { userId: "administrator" })).status).toBe(503);
  expect((await requestApi("/api/local/seed", await signToken("admin@example.test"), "POST", {})).status).toBe(503);

  await transact(env.DB, (state): void => {
    state.users = state.users.map((user) => (user.id === reviewer.id ? { ...user, role: "administrator" } : user));
  });
  expect((await queryAccessIdentity(env.DB, token, configuration)).role).toBe("administrator");
});

it("enforces call ownership, same-origin writes, safe returns, and alternate-host rejection", async (): Promise<void> => {
  const token = await signToken();
  const response = await requestApi("/api/calls", token, "POST", {});
  expect(response.status).toBe(201);
  const call = (await response.json()) as { id: string };
  expect((await requestApi(`/api/calls/${call.id}`, await signToken("admin@example.test"))).status).toBe(200);
  const other = await requestApi("/api/calls", await signToken("admin@example.test"), "POST", {});
  const privateCall = (await other.json()) as { id: string };
  expect((await requestApi(`/api/calls/${privateCall.id}`, token)).status).toBe(404);
  expect(
    (
      await requestApi(`/api/calls/${privateCall.id}/end`, token, "POST", {
        connection: "Ended normally",
        transcriptComplete: true,
      })
    ).status,
  ).toBe(404);
  expect((await requestApi("/api/identity", token, "GET", undefined, "https://alternate.workers.dev")).status).toBe(
    403,
  );
  expect((await requestApi("/api/login?returnTo=https://untrusted.example", token)).status).toBe(400);
  const home = await requestApi("/api/login?returnTo=%2F", token);
  expect(home.status).toBe(303);
  expect(home.headers.get("Location")).toBe("/?account=signed-in");
  const navigation = await requestApi("/api/login?returnTo=%2Fdashboard%2Fcall%3Fcall%3Dexample", token);
  expect(navigation.status).toBe(303);
  expect(navigation.headers.get("Location")).toBe("/dashboard/call?call=example&account=signed-in");
  const context = createExecutionContext();
  expect(
    (
      await api.fetch(
        new Request(`${origin}/api/calls`, {
          method: "POST",
          headers: { Origin: "https://untrusted.example", "Cf-Access-Jwt-Assertion": token },
          body: "{}",
        }),
        configuration,
        context,
      )
    ).status,
  ).toBe(403);
});

it("revokes the current token immediately and permits a fresh login token", async (): Promise<void> => {
  const token = await signToken();
  expect((await requestApi("/api/session", token, "DELETE")).status).toBe(200);
  expect((await requestApi("/api/identity", token)).status).toBe(401);
  expect((await requestApi("/api/calls", token, "POST", {})).status).toBe(401);
  const freshToken = await signToken(undefined, { expiration: Math.floor(Date.now() / 1000) + 7200 });
  expect((await requestApi("/api/identity", freshToken)).status).toBe(200);
});

it("keeps public assets available without the API and validates cookies before exposing identity", async (): Promise<void> => {
  const token = await signToken();
  const bindings = {
    AUTH_MODE: "access",
    PUBLIC_ORIGIN: origin,
    ASSETS: { fetch: async (): Promise<Response> => new Response("public sample") },
    API: {
      fetch: async (request: Request): Promise<Response> => {
        const context = createExecutionContext();
        const response = await api.fetch(request, configuration, context);
        await waitOnExecutionContext(context);
        return response;
      },
    },
  };
  expect(
    await (await application.fetch(new Request(`${origin}/dashboard`), { ...bindings, API: undefined })).text(),
  ).toBe("public sample");
  expect(await (await application.fetch(new Request(`${origin}/auth/identity`), bindings)).json()).toEqual({
    user: null,
    identities: [],
  });
  expect(
    await (
      await application.fetch(
        new Request(`${origin}/auth/identity`, { headers: { Cookie: `CF_Authorization=${token}` } }),
        bindings,
      )
    ).json(),
  ).toEqual({ user: reviewer, identities: [] });
  expect((await application.fetch(new Request("https://alternate.workers.dev/dashboard"), bindings)).status).toBe(403);
  expect((await application.fetch(new Request(`${origin}/api/calls`), bindings)).status).toBe(401);
  const { state } = await readState(env.DB);
  expect(calculateAvailableMicrodollars(state, new Date().toISOString())).toBe(25_000_000);
});
