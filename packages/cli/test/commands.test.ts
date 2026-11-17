import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dependencies = fileURLToPath(new URL("./fixtures/dependencies.ts", import.meta.url));
const environment = fileURLToPath(new URL("./fixtures/environment.ts", import.meta.url));
const receipt = { scope: "daily_calls", resetAt: "2026-11-17T12:00:00.000Z" };
let server: Server;
let origin: string;
let sessionStatus: number;
let resetStatus: number;
let requests: { method?: string; path?: string; cookie?: string; origin?: string; body: string }[];

async function invokeCommand(
  parameters: string[],
  command = process.execPath,
  directory?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const arguments_ =
    command === process.execPath
      ? ["--import", directory ? environment : dependencies, entry, ...parameters]
      : ["--silent", ...parameters];
  const child = spawn(command, arguments_, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(directory
        ? { FREIGHT_CLI_EVALUATION_DIRECTORY: directory, PROMPTFOO_CONFIG_DIR: join(directory, "promptfoo") }
        : {}),
    },
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8").on("data", (data: string): void => {
    stdout += data;
  });
  child.stderr.setEncoding("utf8").on("data", (data: string): void => {
    stderr += data;
  });

  const timeout = setTimeout((): void => {
    child.kill();
  }, 15_000);

  try {
    const [status] = await once(child, "close");
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

beforeEach(async (): Promise<void> => {
  requests = [];
  sessionStatus = 200;
  resetStatus = 200;
  server = createServer(async (request, response): Promise<void> => {
    request.setEncoding("utf8");
    let body = "";

    for await (const chunk of request) {
      body += String(chunk);
    }

    requests.push({
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie,
      origin: request.headers.origin,
      body,
    });

    if (request.url === "/api/session" && request.method === "POST") {
      response.writeHead(sessionStatus, {
        ...(sessionStatus === 200 ? { "Set-Cookie": "session=local-administrator; HttpOnly; Path=/" } : {}),
        ...(sessionStatus === 302 ? { Location: `${origin}/unexpected` } : {}),
      });
      response.end("{}");
      return;
    }

    response.writeHead(request.method === "DELETE" ? 200 : resetStatus, { "Content-Type": "application/json" });
    response.end(JSON.stringify(receipt));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Local test server did not receive a port.");
  }

  origin = `http://127.0.0.1:${address.port}`;
});

afterEach(async (): Promise<void> => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject): void => {
    server.close((error): void => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
});

it("shows evaluation and quota help without loading the evaluation runtime or contacting Workers", async (): Promise<void> => {
  for (const parameters of [["--help"], ["eval", "--help"], ["dev", "limits", "reset", "--help"]]) {
    const result = await invokeCommand([...parameters, "--json"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("pnpm --silent cli");
    expect(result.stderr).toBe("");
  }

  expect(requests).toEqual([]);
});

it("rejects invalid evaluations and unrelated options before loading the evaluation runtime", async (): Promise<void> => {
  for (const parameters of [
    ["eval", "--suite", "unknown"],
    ["eval", "one", "two"],
    ["eval", "no-matching-evaluation-case"],
    ["eval", "--database", "missing.sqlite"],
    ["dev", "limits", "reset", "--persist-to", "missing"],
  ]) {
    const result = await invokeCommand([...parameters, "--json"]);

    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("usage_invalid");
  }

  expect(requests).toEqual([]);
});

it.each([
  ["dallas-fragmented-acceptance", 0, 1],
  ["dallas-fragmented-wrong-rate", 1, 0],
])(
  "runs %s through the evaluation CLI with clean JSON and the scoring exit code",
  async (prefix, status, passed): Promise<void> => {
    const directory = await mkdtemp(join(tmpdir(), "freight-cli-evaluation-"));

    try {
      const result = await invokeCommand(
        ["eval", "--suite", "confirmations", prefix, "--json"],
        process.execPath,
        directory,
      );

      expect(result.status, result.stderr).toBe(status);
      expect(result.stderr).toContain("Evaluations:");

      const summary = JSON.parse(result.stdout);
      expect(summary).toMatchObject({ cases: 1, completed: 1, passed, errors: 0, unresolvedRequests: 0, requests: 1 });
      expect(summary.path).toBe(join(directory, "evals/results", summary.runId, "results.json"));

      const report = JSON.parse(await readFile(summary.path, "utf8"));
      expect(report.results[0].result.usage).toHaveLength(1);
      expect(report.results[0].result.usage[0].unresolved).toBe(false);
      expect(report.passed).toBe(passed);
      expect(summary.results[0].id).toBe(prefix);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it("resets quotas through the local administrator session and emits one JSON receipt", async (): Promise<void> => {
  const result = await invokeCommand(["--json", "dev", "limits", "reset", "--origin", origin]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(receipt);
  expect(requests).toEqual([
    { method: "POST", path: "/api/session", origin, body: '{"userId":"administrator"}', cookie: undefined },
    { method: "POST", path: "/api/local/limits/reset", origin, body: "{}", cookie: "session=local-administrator" },
    { method: "DELETE", path: "/api/session", origin, body: "", cookie: "session=local-administrator" },
  ]);
});

it("reports a rejected reset as an operational failure and removes the administrator session", async (): Promise<void> => {
  resetStatus = 403;
  const result = await invokeCommand(["dev", "limits", "reset", "--origin", origin, "--json"]);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toMatchObject({
    code: "quota_reset_failed",
    message: expect.stringContaining("403"),
    hint: expect.any(String),
  });
  expect(requests.at(-1)).toMatchObject({ method: "DELETE", path: "/api/session" });
});

it.each([401, 302])(
  "stops after administrator sign-in fails with HTTP %s without following redirects",
  async (status): Promise<void> => {
    sessionStatus = status;
    const result = await invokeCommand(["dev", "limits", "reset", "--origin", origin, "--json"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("quota_reset_failed");
    expect(requests).toHaveLength(1);
  },
);

it("rejects invalid and non-loopback origins before contacting Workers", async (): Promise<void> => {
  for (const value of [
    "invalid",
    "https://example.com",
    "http://0.0.0.0",
    `${origin}/path`,
    `${origin}?query`,
    `http://user@${new URL(origin).host}`,
  ]) {
    const result = await invokeCommand(["dev", "limits", "reset", "--origin", value, "--json"]);

    expect(result.status, value).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error.code).toBe("usage_invalid");
  }

  expect(requests).toEqual([]);
});

it("preserves argument forwarding and output through the existing package shortcuts", async (): Promise<void> => {
  const help = await invokeCommand(["eval:help"], "pnpm");
  expect(help.status, help.stderr).toBe(0);
  expect(help.stdout).toContain("cli eval");

  const evaluation = await invokeCommand(["eval", "--suite", "unknown", "--json"], "pnpm");
  expect(evaluation.status).toBe(2);
  expect(evaluation.stdout).toBe("");
  expect(JSON.parse(evaluation.stderr).error.code).toBe("usage_invalid");

  const reset = await invokeCommand(["dev:reset:limits", "--origin", origin, "--json"], "pnpm");
  expect(reset.status, reset.stderr).toBe(0);
  expect(reset.stderr).toBe("");
  expect(JSON.parse(reset.stdout)).toEqual(receipt);
});
