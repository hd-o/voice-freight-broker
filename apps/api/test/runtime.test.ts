import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import api from "../src/worker";

it("connects the API to local D1 and the Tools RPC entrypoint", async (): Promise<void> => {
  const response = await SELF.fetch("https://example.test/api/health");

  expect(response.status).toBe(200);

  expect(await response.json()).toEqual({
    service: "api",
    database: "ready",
    tools: { service: "tools", database: "ready" },
  });
});

it("logs unexpected API failures without exposing error details", async (): Promise<void> => {
  const log = vi.spyOn(console, "error").mockImplementation((): void => {});
  const database = new Proxy(env.DB, {
    get(target, property, receiver): unknown {
      if (property === "prepare") {
        return (): never => {
          throw new Error("private diagnostic data");
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });
  const context = createExecutionContext();

  try {
    const response = await api.fetch(new Request("https://example.test/api/health"), { ...env, DB: database }, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith({ event: "api_request_failed", route: "/api/health", method: "GET" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private diagnostic data");
  } finally {
    log.mockRestore();
  }
});
