import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("connects the API to local D1 and the Tools RPC entrypoint", async (): Promise<void> => {
  const response = await SELF.fetch("https://example.test/api/health");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    service: "api",
    database: "ready",
    tools: { service: "tools", database: "ready" },
  });
});
