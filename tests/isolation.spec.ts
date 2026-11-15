import type { TestHarness } from "wrangler";
import { createTestBackend, expect, test } from "./fixtures";

type DatabaseBindings = {
  DB: {
    prepare(query: string): { first(column: string): Promise<unknown> };
  };
};

async function requestApi(
  backend: TestHarness,
  path: string,
  cookie?: string,
  body?: unknown,
): ReturnType<TestHarness["fetch"]> {
  const { url } = await backend.listen();

  return backend.fetch(new URL(`/api${path}`, url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: url.origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn(backend: TestHarness): Promise<string> {
  const response = await requestApi(backend, "/session", undefined, {
    userId: "administrator",
  });

  expect(response.status).toBe(200);

  const cookie = response.headers.get("set-cookie");

  if (!cookie) {
    throw new Error("Sign-in must set a session cookie");
  }

  return cookie.split(";")[0];
}

test("backends isolate fixed accounts and reset storage across both Workers", async ({ backend }): Promise<void> => {
  const otherBackend = createTestBackend();

  try {
    await otherBackend.listen();
    await otherBackend.getWorker().applyD1Migrations("DB");

    for (const server of [backend, otherBackend]) {
      const response = await requestApi(server, "/health");
      expect(response.status).toBe(200);

      expect(await response.json()).toEqual({
        service: "api",
        database: "ready",
        tools: { service: "tools", database: "ready" },
      });
    }

    const cookie = await signIn(backend);
    const otherCookie = await signIn(otherBackend);
    const seed = await requestApi(backend, "/local/seed", cookie, {});
    expect(seed.status).toBe(200);
    const call = await requestApi(backend, "/calls", cookie, {});
    expect(call.status).toBe(201);

    for (const [server, count] of [
      [backend, 1],
      [otherBackend, 0],
    ] as const) {
      const tools = await server.getWorker<DatabaseBindings>("voice-freight-tools").getEnv();
      expect(await tools.DB.prepare("SELECT COUNT(*) AS count FROM calls").first("count")).toBe(count);

      expect(await tools.DB.prepare("SELECT id FROM users WHERE id = 'administrator'").first("id")).toBe(
        "administrator",
      );
    }

    const dashboard = await requestApi(backend, "/dashboard", cookie);

    expect(await dashboard.json()).toMatchObject({
      calls: [expect.anything()],
    });

    const otherDashboard = await requestApi(otherBackend, "/dashboard", otherCookie);
    expect(await otherDashboard.json()).toMatchObject({ calls: [] });
    const otherIdentity = await requestApi(otherBackend, "/identity", cookie);
    expect(await otherIdentity.json()).toMatchObject({ user: null });

    await backend.reset();
    await backend.getWorker().applyD1Migrations("DB");
    const expiredIdentity = await requestApi(backend, "/identity", cookie);
    expect(await expiredIdentity.json()).toMatchObject({ user: null });
    const newCookie = await signIn(backend);
    const emptyDashboard = await requestApi(backend, "/dashboard", newCookie);
    expect(await emptyDashboard.json()).toMatchObject({ calls: [] });
    const resetTools = await backend.getWorker<DatabaseBindings>("voice-freight-tools").getEnv();
    expect(await resetTools.DB.prepare("SELECT COUNT(*) AS count FROM calls").first("count")).toBe(0);
    const remainingIdentity = await requestApi(otherBackend, "/identity", otherCookie);

    expect(await remainingIdentity.json()).toMatchObject({
      user: { id: "administrator" },
    });
  } finally {
    await otherBackend.close();
  }
});
