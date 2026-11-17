import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { synchronizeRoles } from "../src/hosting.ts";

const accountId = "0123456789abcdef0123456789abcdef";
const databaseId = "10000000-0000-4000-8000-000000000001";
let directory: string;
let databasePath: string;

let hosting: {
  accountId: string;
  databaseId: string;
  databaseName: string;
  administrators: string[];
  reviewers: string[];
};

async function saveHosting(): Promise<void> {
  await writeFile(join(directory, "hosting.json"), JSON.stringify(hosting));
}

async function queryUsers(): Promise<{ users: unknown[]; revision: unknown; calls: unknown }> {
  const database = new DatabaseSync(databasePath);

  try {
    return {
      users: database
        .prepare("SELECT data FROM users ORDER BY id")
        .all()
        .map((row): unknown => JSON.parse(String(row.data))),
      revision: database.prepare("SELECT version FROM revision WHERE id=1").get()?.version,
      calls: database.prepare("SELECT data FROM calls WHERE id='saved'").get()?.data,
    };
  } finally {
    database.close();
  }
}

beforeEach(async (): Promise<void> => {
  directory = await mkdtemp(join(tmpdir(), "freight-hosting-test-"));
  databasePath = join(directory, "database.sqlite");

  hosting = {
    accountId,
    databaseId,
    databaseName: "voice-freight-hosted",
    administrators: [" ADMIN@example.com "],
    reviewers: ["o'brien@example.com"],
  };

  await mkdir(join(directory, "apps/api"), { recursive: true });
  await mkdir(join(directory, "bin"));

  await writeFile(
    join(directory, "apps/api/wrangler.jsonc"),
    `{
      // Comments and trailing commas are accepted by Wrangler.
      "account_id": "${accountId}",
      "d1_databases": [
        {"binding":"DB","database_id":"${databaseId}","database_name":"voice-freight-hosted"},
      ],
    }`,
  );

  await saveHosting();

  const database = new DatabaseSync(databasePath);

  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE revision (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE calls (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    INSERT INTO revision VALUES (1, 7);
    INSERT INTO calls VALUES ('saved', '{"transcript":"retained"}');
    INSERT INTO users VALUES ('reviewer', '{"id":"reviewer","role":"reviewer"}');
    INSERT INTO users VALUES ('access:removed@example.com', '{"id":"access:removed@example.com","role":"reviewer"}');
    INSERT INTO users VALUES ('access:admin@example.com', '{"id":"access:admin@example.com","role":"reviewer"}');
  `);

  database.close();

  // Exercise the real subprocess boundary while replacing only external services.
  const terraform = join(directory, "bin/terraform");
  const pnpm = join(directory, "bin/pnpm");

  await writeFile(
    terraform,
    `#!${process.execPath}
import { readFileSync } from "node:fs";
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["-chdir=infrastructure","output","-json","hosting"])) process.exit(2);
process.stdout.write(readFileSync("hosting.json", "utf8"));
`,
  );

  await writeFile(
    pnpm,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const parameters = process.argv.slice(2);
writeFileSync("invocation.json", JSON.stringify(parameters));
if (JSON.stringify(parameters.slice(0,6)) !== JSON.stringify(["exec","wrangler","d1","execute","DB","--remote"])) process.exit(2);
const path = parameters[parameters.indexOf("--file")+1];
writeFileSync("sql-path.txt", path);
if (process.env.FREIGHT_ROLES_FAILURE === "true") process.exit(1);
const database = new DatabaseSync("database.sqlite");
database.exec(readFileSync(path, "utf8"));
database.close();
process.stdout.write('[{"success":true}]');
`,
  );

  await Promise.all([chmod(terraform, 0o755), chmod(pnpm, 0o755)]);
  vi.stubEnv("PATH", `${join(directory, "bin")}:${process.env.PATH}`);
});

afterEach(async (): Promise<void> => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("synchronizes additions, role changes and removals while preserving other data", async (): Promise<void> => {
  expect(await synchronizeRoles(directory)).toEqual({ databaseId, administrators: 1, reviewers: 1 });

  const first = await queryUsers();

  expect(first).toEqual({
    users: [
      { id: "access:admin@example.com", name: "admin@example.com", role: "administrator" },
      { id: "access:o'brien@example.com", name: "o'brien@example.com", role: "reviewer" },
      { id: "reviewer", role: "reviewer" },
    ],
    revision: 8,
    calls: '{"transcript":"retained"}',
  });

  await synchronizeRoles(directory);
  expect(await queryUsers()).toEqual({ ...first, revision: 9 });

  const parameters: string[] = JSON.parse(await readFile(join(directory, "invocation.json"), "utf8"));

  expect(parameters).toContain(join(directory, "apps/api/wrangler.jsonc"));
  expect(parameters.at(-1)).toBe("--json");
  expect(parameters[parameters.indexOf("--env") + 1]).toBe("");

  const path = await readFile(join(directory, "sql-path.txt"), "utf8");

  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });

  hosting.reviewers = [];
  await saveHosting();
  await synchronizeRoles(directory);
  expect((await queryUsers()).users).toHaveLength(2);
});

it.each(["account", "database", "name"])(
  "rejects mismatched %s before invoking Wrangler",
  async (field): Promise<void> => {
    if (field === "account") {
      hosting.accountId = "f".repeat(32);
    } else if (field === "database") {
      hosting.databaseId = "20000000-0000-4000-8000-000000000002";
    } else {
      hosting.databaseName = "other-database";
    }

    await saveHosting();
    await expect(synchronizeRoles(directory)).rejects.toMatchObject({ code: "roles_configuration_invalid" });
    await expect(readFile(join(directory, "invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await queryUsers()).revision).toBe(7);
  },
);

it.each(["empty", "overlap", "duplicate", "email"])(
  "rejects invalid %s user lists before hosted writes",
  async (field): Promise<void> => {
    if (field === "empty") {
      hosting.administrators = [];
    } else if (field === "overlap") {
      hosting.reviewers = ["admin@EXAMPLE.com"];
    } else if (field === "duplicate") {
      hosting.reviewers = ["reviewer@example.com", "Reviewer@example.com"];
    } else {
      hosting.reviewers = ["not-an-email"];
    }

    await saveHosting();
    await expect(synchronizeRoles(directory)).rejects.toMatchObject({ code: "roles_configuration_invalid" });
    await expect(readFile(join(directory, "invocation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("cleans up SQL and reports a failed Wrangler command", async (): Promise<void> => {
  vi.stubEnv("FREIGHT_ROLES_FAILURE", "true");
  await expect(synchronizeRoles(directory)).rejects.toMatchObject({ code: "roles_sync_failed" });

  const path = await readFile(join(directory, "sql-path.txt"), "utf8");

  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await queryUsers()).revision).toBe(7);
});
