import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Identity } from "@voice-freight/contracts/business";
import { loadEnvironment, requestCloudflare } from "./cloudflare.ts";
import { repositoryPath } from "./database.ts";
import { CommandError } from "./errors.ts";
import { runTerraform } from "./terraform.ts";

const email = z
  .string()
  .trim()
  .email()
  .transform((value): string => value.toLowerCase());
const configurationSchema = z.object({
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  databaseId: z.string().uuid(),
  databaseName: z.string().min(1),
  administrators: z.array(email).min(1),
  reviewers: z.array(email),
  apiWorkerName: z.string().default("voice-freight-api"),
});
type Configuration = z.infer<typeof configurationSchema>;

export function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export async function readConfiguration(variable?: string): Promise<Configuration> {
  const content = variable
    ? process.env[variable]
    : await runTerraform(["-chdir=infrastructure", "output", "-json", "hosting"], true);

  if (!content) {
    throw new CommandError(
      "roles_configuration_invalid",
      "Deployed configuration is missing.",
      "Apply Terraform or provide the requested configuration environment variable.",
    );
  }
  const configuration = configurationSchema.parse(JSON.parse(content));
  const account = loadEnvironment().CLOUDFLARE_ACCOUNT_ID;

  if (account && account !== configuration.accountId) {
    throw new CommandError(
      "account_mismatch",
      "The configured account does not match the selected Cloudflare account.",
      "Check the applied Terraform account before updating production.",
    );
  }

  const administrators = new Set(configuration.administrators);
  const reviewers = new Set(configuration.reviewers);

  if (
    administrators.size !== configuration.administrators.length ||
    reviewers.size !== configuration.reviewers.length ||
    configuration.reviewers.some((value): boolean => administrators.has(value))
  ) {
    throw new CommandError(
      "roles_configuration_invalid",
      "Each email must have exactly one configured role.",
      "Correct the administrator and reviewer lists.",
    );
  }

  return configuration;
}

async function validateDatabase(configuration: Configuration): Promise<void> {
  const details = z
    .object({ name: z.string() })
    .parse(await requestCloudflare(`/accounts/${configuration.accountId}/d1/database/${configuration.databaseId}`));

  if (details.name !== configuration.databaseName) {
    throw new CommandError(
      "database_mismatch",
      "The deployed database name does not match its configuration.",
      "Check the applied Terraform database identity.",
    );
  }
}

async function query(configuration: Configuration, sql: string): Promise<unknown> {
  return await requestCloudflare(`/accounts/${configuration.accountId}/d1/database/${configuration.databaseId}/query`, {
    method: "POST",
    body: { sql },
  });
}

export async function openDeployedDatabase(variable?: string): Promise<{
  id: string;
  query: (sql: string) => Promise<unknown>;
}> {
  const configuration = await readConfiguration(variable);
  await validateDatabase(configuration);

  return { id: configuration.databaseId, query: (sql): Promise<unknown> => query(configuration, sql) };
}

export async function migrateDatabase(variable?: string): Promise<{ applied: string[] }> {
  const configuration = await readConfiguration(variable);
  await validateDatabase(configuration);
  await query(
    configuration,
    "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);",
  );
  const response = z
    .array(z.object({ results: z.array(z.object({ name: z.string() })) }))
    .parse(await query(configuration, "SELECT name FROM d1_migrations ORDER BY id;"));
  const applied = new Set(response.flatMap((result): string[] => result.results.map((row): string => row.name)));
  const directory = join(repositoryPath, "packages/backend/migrations");
  const files = (await readdir(directory)).filter((name): boolean => /^\d+.*\.sql$/.test(name)).sort();
  const completed: string[] = [];

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(join(directory, file), "utf8");

    // Wrangler stores each complete migration and its journal entry together;
    // preserving the full file also preserves trigger bodies.
    await query(configuration, `${sql}\nINSERT INTO d1_migrations (name) VALUES (${quoteSql(file)});`);
    completed.push(file);
  }

  return { applied: completed };
}

export async function synchronizeRoles(
  variable?: string,
): Promise<{ databaseId: string; administrators: number; reviewers: number }> {
  const configuration = await readConfiguration(variable);
  await validateDatabase(configuration);
  const identities = [
    ...configuration.administrators.map((value): Identity => ({
      id: `access:${value}`,
      name: value,
      role: "administrator",
    })),
    ...configuration.reviewers.map((value): Identity => ({ id: `access:${value}`, name: value, role: "reviewer" })),
  ];
  const identifiers = identities.map((identity): string => quoteSql(identity.id)).join(",");
  const statements = identities.map(
    (identity): string =>
      `INSERT INTO users (id, data) VALUES (${quoteSql(identity.id)}, ${quoteSql(JSON.stringify(identity))}) ON CONFLICT(id) DO UPDATE SET data=excluded.data;`,
  );

  await query(
    configuration,
    [
      `DELETE FROM users WHERE id LIKE 'access:%' AND id NOT IN (${identifiers});`,
      ...statements,
      "UPDATE revision SET version=version+1 WHERE id=1;",
    ].join("\n"),
  );

  return {
    databaseId: configuration.databaseId,
    administrators: configuration.administrators.length,
    reviewers: configuration.reviewers.length,
  };
}

export async function synchronizeSecret(variable?: string): Promise<{ configured: boolean }> {
  const configuration = await readConfiguration(variable);
  const key = loadEnvironment().OPENAI_API_KEY;

  if (!key) {
    throw new CommandError(
      "secret_missing",
      "The deployed OpenAI key is missing.",
      "Provide OPENAI_API_KEY in the environment for initial provisioning or rotation.",
    );
  }
  await requestCloudflare(
    `/accounts/${configuration.accountId}/workers/scripts/${encodeURIComponent(configuration.apiWorkerName)}/secrets`,
    { method: "PUT", body: { name: "OPENAI_API_KEY", text: key, type: "secret_text" } },
  );
  return { configured: true };
}
