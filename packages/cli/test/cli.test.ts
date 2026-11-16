import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

const entryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
let directory: string;
let databasePath: string;

function invokeCli(parameters: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entryPath, ...parameters], {
    encoding: "utf8",
    cwd: directory,
    timeout: 10000,
  });

  if (result.error) {
    throw result.error;
  }

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function invokeDatabase(parameters: string[]): ReturnType<typeof invokeCli> {
  return invokeCli(["--database", databasePath, ...parameters, "--json"]);
}

beforeEach((): void => {
  directory = mkdtempSync(join(tmpdir(), "freight-cli-"));
  const storage = join(directory, "v3/d1/miniflare-D1DatabaseObject");
  mkdirSync(storage, { recursive: true });
  databasePath = join(storage, "fixture.sqlite");
  const database = new DatabaseSync(databasePath);

  database.exec(`
    CREATE TABLE calls (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE liveSessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE transcriptFragments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE INDEX call_data ON calls(data);
    CREATE VIEW call_ids AS SELECT id FROM calls;
    CREATE TRIGGER call_trigger AFTER DELETE ON calls BEGIN DELETE FROM liveSessions WHERE id = old.id; END;
  `);

  const savedTranscript = {
    complete: false,
    entries: [{ id: "saved", speaker: "carrier", offsetSeconds: 2, text: "Saved dialogue" }],
  };
  const record = { transcript: { complete: true, entries: [] } };

  database
    .prepare("INSERT INTO calls VALUES (?, ?)")
    .run("live", JSON.stringify({ record, finalSnapshot: { transcript: savedTranscript } }));
  database
    .prepare("INSERT INTO calls VALUES (?, ?)")
    .run("saved", JSON.stringify({ record, finalSnapshot: { transcript: savedTranscript } }));
  database
    .prepare("INSERT INTO calls VALUES (?, ?)")
    .run("empty", JSON.stringify({ record: { transcript: { complete: false, entries: [] } }, finalSnapshot: null }));
  database.prepare("INSERT INTO liveSessions VALUES (?, '{}')").run("live");

  // Insert out of order, with equal timestamps resolved by sequence and a long pause retained.
  const fragments = [
    { id: "c", callId: "live", speaker: "broker", startMs: 100, endMs: 200, sequence: 1, text: " there" },
    { id: "a", callId: "live", speaker: "broker", startMs: 100, endMs: 200, sequence: 0, text: "Hello" },
    { id: "b", callId: "live", speaker: "carrier", startMs: 400, endMs: 800, sequence: 2, text: "Thanks" },
    { id: "d", callId: "live", speaker: "carrier", startMs: 3000, endMs: 3200, sequence: 3, text: "Another turn" },
    { id: "other", callId: "another-call", speaker: "carrier", startMs: 0, endMs: 0, sequence: 0, text: "Unrelated" },
  ];

  for (const fragment of fragments) {
    database.prepare("INSERT INTO transcriptFragments VALUES (?, ?)").run(fragment.id, JSON.stringify(fragment));
  }

  database.close();
});

afterEach((): void => {
  rmSync(directory, { recursive: true, force: true });
});

it("discovers commands and examples without accessing a database", (): void => {
  for (const parameters of [
    ["--help"],
    ["calls", "transcript", "--help"],
    ["db", "schema", "--help"],
    ["db", "query", "--help"],
  ]) {
    const result = invokeCli(parameters);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("pnpm --silent cli");
    expect(result.stderr).toBe("");
  }
});

it("retrieves only the requested live transcript and uses current completion", (): void => {
  const result = invokeDatabase(["calls", "transcript", "live"]);

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    callId: "live",
    complete: true,
    entries: [
      { id: "a", speaker: "broker", startMs: 100, endMs: 200, text: "Hello there" },
      { id: "b", speaker: "carrier", startMs: 400, endMs: 800, text: "Thanks" },
      { id: "d", speaker: "carrier", startMs: 3000, endMs: 3200, text: "Another turn" },
    ],
  });

  const text = invokeCli(["calls", "transcript", "live", "--database", databasePath]);
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("[00:00] broker: Hello there");
});

it("supports saved and empty transcripts while distinguishing missing calls", (): void => {
  expect(JSON.parse(invokeDatabase(["calls", "transcript", "saved"]).stdout)).toMatchObject({
    complete: true,
    entries: [{ text: "Saved dialogue", startMs: 2000, endMs: 2000 }],
  });
  expect(JSON.parse(invokeDatabase(["calls", "transcript", "empty"]).stdout)).toEqual({
    callId: "empty",
    complete: false,
    entries: [],
  });

  const missing = invokeDatabase(["calls", "transcript", "missing"]);
  expect(missing.status).toBe(3);
  expect(missing.stdout).toBe("");
  expect(JSON.parse(missing.stderr).error.code).toBe("call_missing");
});

it("reports corrupt stored transcript data as an operational failure", (): void => {
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE calls SET data = ? WHERE id = 'live'").run('{"record": {}}');
  database.close();

  const result = invokeDatabase(["calls", "transcript", "live"]);
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr).error.code).toBe("transcript_invalid");
  expect(result.stdout).toBe("");
});

it("inspects actual schema including related indexes and triggers", (): void => {
  const result = invokeDatabase(["db", "schema", "calls"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).objects).toEqual([
    expect.objectContaining({
      type: "index",
      name: "call_data",
      tableName: "calls",
      sql: expect.stringContaining("CREATE INDEX"),
    }),
    expect.objectContaining({ type: "table", name: "calls" }),
    expect.objectContaining({ type: "trigger", name: "call_trigger" }),
  ]);
  expect(JSON.parse(invokeDatabase(["db", "schema"]).stdout).objects).toContainEqual(
    expect.objectContaining({ type: "view", name: "call_ids" }),
  );
  expect(invokeDatabase(["db", "schema", "missing"]).status).toBe(3);
});

it("queries SQL with bounded rows and JSON-safe integer and blob values", (): void => {
  const result = invokeDatabase(["db", "query", "SELECT id FROM calls ORDER BY id", "--limit", "2"]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    columns: ["id"],
    rows: [{ id: "empty" }, { id: "live" }],
    count: 2,
    truncated: true,
  });
  expect(
    JSON.parse(invokeDatabase(["db", "query", "SELECT id FROM calls ORDER BY id", "--limit", "3"]).stdout).truncated,
  ).toBe(false);
  expect(
    JSON.parse(
      invokeDatabase([
        "db",
        "query",
        "WITH value AS (SELECT 9007199254740993 AS n) SELECT n, X'ff00' AS blob FROM value;",
      ]).stdout,
    ).rows,
  ).toEqual([{ n: "9007199254740993", blob: "ff00" }]);
});

it("rejects unsafe SQL and multiple statements without changing the database", (): void => {
  const queries = [
    "DELETE FROM calls",
    "UPDATE calls SET data = '{}' RETURNING id",
    "DROP TABLE calls",
    "CREATE TEMP TABLE scratch (id TEXT)",
    "ATTACH DATABASE ':memory:' AS extra",
    "PRAGMA query_only = OFF",
    "VACUUM INTO 'copy.sqlite'",
    "SELECT 1; DELETE FROM calls",
    "SELECT 1; SELECT 2",
  ];

  for (const query of queries) {
    const result = invokeDatabase(["db", "query", query]);
    expect(result.status, query).toBe(2);
    expect(result.stdout, query).toBe("");
    expect(JSON.parse(result.stderr).error.hint, query).toBeTruthy();
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  expect(database.prepare("SELECT count(*) AS count FROM calls").get()?.count).toBe(3);
  database.close();
});

it("returns structured usage errors for parsing, SQL, and validation failures", (): void => {
  for (const parameters of [
    ["unknown"],
    ["db", "query"],
    ["--unknown"],
    ["calls", "transcript", "   "],
    ["db", "query", "SELECT 1", "--limit", "0"],
    ["db", "query", "SELECT 1", "--limit", "1001"],
    ["db", "query", "invalid sql"],
    ["db", "query", "SELECT 1 AS duplicate, 2 AS duplicate"],
  ]) {
    const result = invokeDatabase(parameters);
    expect(result.status, parameters.join(" ")).toBe(2);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toEqual({
      code: expect.any(String),
      message: expect.any(String),
      hint: expect.any(String),
    });
  }
});

it("discovers selected storage, ignores metadata, and refuses ambiguous or absent files", (): void => {
  const metadata = new DatabaseSync(join(directory, "v3/d1/miniflare-D1DatabaseObject/metadata.sqlite"));
  metadata.close();
  expect(invokeCli(["db", "schema", "--persist-to", directory, "--json"]).status).toBe(0);

  const second = new DatabaseSync(join(directory, "v3/d1/miniflare-D1DatabaseObject/second.sqlite"));
  second.close();
  const ambiguous = invokeCli(["--json", "--persist-to", directory, "db", "schema"]);
  expect(ambiguous.status).toBe(2);
  expect(JSON.parse(ambiguous.stderr).error).toMatchObject({
    code: "database_ambiguous",
    hint: expect.stringContaining("fixture.sqlite"),
  });
  expect(invokeDatabase(["db", "schema"]).status).toBe(0);
  expect(invokeCli(["--database", join(directory, "missing.sqlite"), "db", "schema", "--json"]).status).toBe(3);
  expect(invokeCli(["--persist-to", join(directory, "absent"), "db", "schema", "--json"]).status).toBe(3);
});

it("preserves JSON streams and exit codes through the documented package command", (): void => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));

  for (const [parameters, status] of [
    [["db", "query", "SELECT 1 AS ready"], 0],
    [["unknown"], 2],
    [["calls", "transcript", "missing"], 3],
  ] as const) {
    const result = spawnSync("pnpm", ["--silent", "cli", "--database", databasePath, ...parameters, "--json"], {
      encoding: "utf8",
      cwd: root,
      timeout: 10000,
    });

    expect(result.status, result.stderr).toBe(status);

    if (status === 0) {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).rows).toEqual([{ ready: 1 }]);
    } else {
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr).error.hint).toBeTruthy();
    }
  }
});
