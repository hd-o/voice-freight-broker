import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse, type ParseError } from "jsonc-parser";
import { z } from "zod";
import type { Identity } from "@voice-freight/contracts/business";
import { repositoryPath } from "./database.ts";
import { CommandError } from "./errors.ts";

const execution = promisify(execFile);

const emailSchema = z
  .string()
  .trim()
  .email()
  .transform((email): string => email.toLowerCase());

const hostingSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  databaseId: z.string().uuid(),
  databaseName: z.string().min(1),
  administrators: z.array(emailSchema).min(1),
  reviewers: z.array(emailSchema),
});

const configurationSchema = z.object({
  account_id: z.string(),
  d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string(), database_name: z.string() })),
});

type RoleReceipt = {
  databaseId: string;
  administrators: number;
  reviewers: number;
};

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function synchronizeRoles(directory = repositoryPath): Promise<RoleReceipt> {
  const hint = "Apply Terraform, verify its hosting output against apps/api/wrangler.jsonc, and apply D1 migrations.";
  let hosting: z.infer<typeof hostingSchema>;

  try {
    const { stdout } = await execution("terraform", ["-chdir=infrastructure", "output", "-json", "hosting"], {
      cwd: directory,
      timeout: 30_000,
    });

    hosting = hostingSchema.parse(JSON.parse(stdout));

    const administrators = new Set(hosting.administrators);
    const reviewers = new Set(hosting.reviewers);

    if (
      administrators.size !== hosting.administrators.length ||
      reviewers.size !== hosting.reviewers.length ||
      hosting.reviewers.some((email): boolean => administrators.has(email))
    ) {
      throw new Error("Each email must have exactly one configured role.");
    }
  } catch (error) {
    throw new CommandError(
      "roles_configuration_invalid",
      error instanceof Error ? error.message : "Cannot read deployed role configuration.",
      hint,
    );
  }

  const configurationPath = join(directory, "apps/api/wrangler.jsonc");

  try {
    const errors: ParseError[] = [];
    const document: unknown = parse(await readFile(configurationPath, "utf8"), errors, { allowTrailingComma: true });

    if (errors.length) {
      throw new Error("Cannot parse apps/api/wrangler.jsonc.");
    }

    const configuration = configurationSchema.parse(document);
    const database = configuration.d1_databases.find((binding): boolean => binding.binding === "DB");

    // Role removal is destructive: stale Terraform state must never authorize
    // users against a different account or database selected by Wrangler.
    if (
      configuration.account_id !== hosting.accountId ||
      database?.database_id !== hosting.databaseId ||
      database.database_name !== hosting.databaseName
    ) {
      throw new Error("Terraform's deployed account or database does not match apps/api/wrangler.jsonc.");
    }
  } catch (error) {
    throw new CommandError(
      "roles_configuration_invalid",
      error instanceof Error ? error.message : "Cannot read deployed Worker configuration.",
      hint,
    );
  }

  const identities = [
    ...hosting.administrators.map((email): Identity => ({ id: `access:${email}`, name: email, role: "administrator" })),
    ...hosting.reviewers.map((email): Identity => ({ id: `access:${email}`, name: email, role: "reviewer" })),
  ];

  const identifiers = identities.map((identity): string => quoteSql(identity.id)).join(",");

  const statements = identities.map(
    (identity): string =>
      `INSERT INTO users (id, data) VALUES (${quoteSql(identity.id)}, ${quoteSql(JSON.stringify(identity))}) ON CONFLICT(id) DO UPDATE SET data=excluded.data;`,
  );

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "freight-roles-"));

  try {
    const path = join(temporaryDirectory, "roles.sql");

    // Access user lists are operational data. Keep them out of shared schema
    // migrations, and invalidate concurrent domain snapshots after the change.
    await writeFile(
      path,
      [
        `DELETE FROM users WHERE id LIKE 'access:%' AND id NOT IN (${identifiers});`,
        ...statements,
        "UPDATE revision SET version=version+1 WHERE id=1;",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );

    await execution(
      "pnpm",
      [
        "exec",
        "wrangler",
        "d1",
        "execute",
        "DB",
        "--remote",
        "--env",
        "",
        "--config",
        configurationPath,
        "--file",
        path,
        "--json",
      ],
      { cwd: directory, timeout: 90_000 },
    );

    return {
      databaseId: hosting.databaseId,
      administrators: hosting.administrators.length,
      reviewers: hosting.reviewers.length,
    };
  } catch (error) {
    throw new CommandError(
      "roles_sync_failed",
      error instanceof Error ? error.message : "Deployed role synchronization failed.",
      hint,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
