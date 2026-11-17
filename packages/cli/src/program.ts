import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { openDatabase, queryDatabase, querySchema, repositoryPath } from "./database.ts";
import { CommandError, serializeJson } from "./errors.ts";
import { formatTranscript, queryTranscript } from "./transcript.ts";

const inspectionOptionsSchema = z.object({
  database: z.string().trim().min(1).optional(),
  persistTo: z.string().trim().min(1),
  json: z.boolean().default(false),
});

export async function runCli(arguments_: string[]): Promise<void> {
  const program = new Command()
    .name("cli")
    .description("Freight development, inspection, evaluation, and deployment administration commands.")
    .option("--json", "emit compact JSON; errors are JSON on stderr")
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({ writeErr: (): void => {} })
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Usage notes:
  Run from the repository root with the project's Node 26 runtime.
  calls/db inspect local storage read-only, without running Workers or credentials.
  dev limits reset changes daily quotas through running local Workers.
  eval makes paid provider requests using the shared application allowance.
  deployed roles sync changes deployed Access users using applied Terraform state.
  Help never opens storage, contacts Workers, or invokes Terraform or Wrangler.

Database selection (calls/db only):
  Default storage is the repository's .wrangler/state, regardless of working directory.
  Explicit relative paths resolve from the current working directory.
  --database overrides --persist-to. Discovery excludes Wrangler metadata and
  lists candidates on ambiguous matches. Missing databases are never created;
  run pnpm db:migrate to initialize development storage.

Output:
  Results go to stdout; actionable errors go to stderr.
  --json emits compact JSON; errors have {error: {code, message, hint}}.
  Help remains readable text, including with --json.

Examples:
  vpr cli calls transcript <call-id> --json
  vpr cli db schema calls
  vpr cli db query 'SELECT id FROM calls ORDER BY id'

Agents can use "pnpm --silent" like:
  pnpm --silent calls transcript <call-id> --json

Exit codes:
  0 success/help; 1 operational failure, failed evaluation, or invalid stored transcript;
  2 invalid usage, prohibited SQL, or ambiguous database;
  3 missing database, call, table, or view.`,
    );

  const calls = program.command("calls").description("Inspect locally stored calls.");
  const db = program.command("db").description("Inspect a local D1 database without changing it.");

  for (const command of [calls, db]) {
    command
      .option("--database <file>", "use an existing SQLite file instead of storage discovery")
      .option("--persist-to <directory>", "Wrangler storage directory", resolve(repositoryPath, ".wrangler/state"));
  }

  calls
    .command("transcript <call-id>")
    .description("Fetch saved dialogue with timestamps and completion status.")
    .addHelpText(
      "after",
      `
Output:
  Human output shows speaker labels, timestamps, and completion status.
  --json returns {callId, complete, entries} with millisecond timestamps.
  Live fragments use the application's grouping. Saved non-live transcripts
  retain recorded turns; end times equal start times because only offsets exist.
  Empty transcripts succeed; missing calls fail with exit code 3.

Example:
  pnpm --silent cli calls transcript 861f73ea-d16b-4ac5-aaa9-dd25b463dbd7 --json`,
    )
    .action((callId: string, _options: unknown, command: Command): void => {
      const id = z.string().trim().min(1).parse(callId);
      const options = inspectionOptionsSchema.parse(command.optsWithGlobals());
      const database = openDatabase(options);

      try {
        const transcript = queryTranscript(database, id);
        process.stdout.write(`${options.json ? serializeJson(transcript) : formatTranscript(transcript)}\n`);
      } finally {
        database.close();
      }
    });

  db.command("schema [table]")
    .description("List actual table, index, view, and trigger definitions.")
    .addHelpText(
      "after",
      `
Output:
  Reads actual database DDL, including tables, indexes, views, and triggers.
  An optional table or view name filters that object and its related definitions.
  --json returns {objects}, each with type, name, tableName, and sql.
  Missing tables or views fail with exit code 3.

Examples:
  pnpm --silent cli db schema --json
  pnpm --silent cli db schema calls`,
    )
    .action((table: string | undefined, _options: unknown, command: Command): void => {
      const name = z.string().trim().min(1).optional().parse(table);
      const options = inspectionOptionsSchema.parse(command.optsWithGlobals());
      const database = openDatabase(options);

      try {
        const schema = querySchema(database, name);
        process.stdout.write(
          `${options.json ? serializeJson(schema) : schema.objects.map((object): string => `${String(object.type)} ${String(object.name)}\n${String(object.sql ?? "(implicit index)")}`).join("\n\n")}\n`,
        );
      } finally {
        database.close();
      }
    });

  db.command("query <sql>")
    .description("Execute one SELECT or CTE; writes, PRAGMAs, and attachments are prohibited.")
    .option("--limit <rows>", "maximum returned rows (1–1000); use ORDER BY for stable ordering", "100")
    .addHelpText(
      "after",
      `
Query rules:
  Supply one SELECT or CTE. Writes, PRAGMAs, attachments, and additional
  statements are rejected. Use existing migration commands for changes.
  Use ORDER BY for stable ordering and AS aliases for unique column names.
  Most domain tables store JSON in data; inspect fields with json_extract.

Output:
  Returns {columns, rows, count, truncated}; --json emits compact JSON.
  --limit bounds returned rows (default 100, maximum 1,000).
  Integers outside JavaScript's safe range become decimal strings;
  blobs become hex strings.

Examples:
  pnpm --silent cli db query 'SELECT id FROM calls ORDER BY id' --limit 10 --json
  pnpm --silent cli db query "SELECT id, json_extract(data, '$.record.startedAt') AS startedAt FROM calls ORDER BY startedAt DESC" --limit 5 --json`,
    )
    .action((sql: string, _options: unknown, command: Command): void => {
      const query = z.string().trim().min(1).parse(sql);
      const options = inspectionOptionsSchema.parse(command.optsWithGlobals());
      const limit = z.coerce.number().int().min(1).max(1000).parse(command.opts().limit);
      const database = openDatabase(options);

      try {
        const result = queryDatabase(database, query, limit);
        process.stdout.write(`${serializeJson(result, options.json ? undefined : 2)}\n`);
      } finally {
        database.close();
      }
    });

  const dev = program.command("dev").description("Manage the local development environment.");
  const limits = dev.command("limits").description("Manage local daily call quotas.");

  limits
    .command("reset")
    .description("Reset daily call quotas for all local users through running Workers.")
    .option("--origin <url>", "loopback API origin", "http://localhost:8787")
    .addHelpText(
      "after",
      `
Requires local Workers and a seeded development database. Signs in as the local
administrator and removes the command's session afterward. Call history,
spending, and active-call checks are preserved. Deployed environments reject resets.

Example:
  pnpm --silent cli dev limits reset --origin http://localhost:8787 --json`,
    )
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const options = z
        .object({ origin: z.string(), json: z.boolean().default(false) })
        .parse(command.optsWithGlobals());
      const { resetDailyQuotas } = await import("./quotas.ts");
      const receipt = await resetDailyQuotas(options.origin);

      process.stdout.write(
        options.json
          ? `${serializeJson(receipt)}\n`
          : "Local daily call quotas reset. Call history, spending and active-call checks are preserved.\n",
      );
    });

  const deployed = program.command("deployed").description("Administer the deployed installation.");
  const roles = deployed.command("roles").description("Manage deployed application roles.");

  roles
    .command("sync")
    .description("Synchronize deployed application roles.")
    .addHelpText("after", "\nExample:\n  pnpm --silent cli deployed roles sync --json")
    .option("--configuration-env <name>", "environment variable containing resolved configuration")
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const options = z
        .object({ json: z.boolean().default(false), configurationEnv: z.string().optional() })
        .parse(command.optsWithGlobals());
      const { synchronizeRoles } = await import("./hosting.ts");
      const receipt = await synchronizeRoles(options.configurationEnv);
      process.stdout.write(`${serializeJson(receipt, options.json ? undefined : 2)}\n`);
    });

  const schedules = deployed.command("schedules").description("Manage deployed Worker schedules.");
  schedules
    .command("reconcile")
    .description("Reconcile a Terraform-managed Worker schedule.")
    .action(async (): Promise<void> => {
      const { reconcileSchedules } = await import("./schedules.ts");
      await reconcileSchedules();
    });

  const database = deployed.command("database").description("Manage deployed database migrations.");
  database
    .command("migrate")
    .description("Apply pending migrations to the deployed database.")
    .option("--configuration-env <name>", "environment variable containing resolved configuration")
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const options = z
        .object({ json: z.boolean().default(false), configurationEnv: z.string().optional() })
        .parse(command.optsWithGlobals());
      const { migrateDatabase } = await import("./hosting.ts");
      process.stdout.write(
        `${serializeJson(await migrateDatabase(options.configurationEnv), options.json ? undefined : 2)}\n`,
      );
    });

  const secrets = deployed.command("secrets").description("Manage deployed Worker secrets.");
  secrets
    .command("sync")
    .description("Provision the production provider key from the environment.")
    .option("--configuration-env <name>", "environment variable containing resolved configuration")
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const options = z
        .object({ json: z.boolean().default(false), configurationEnv: z.string().optional() })
        .parse(command.optsWithGlobals());
      const { synchronizeSecret } = await import("./hosting.ts");
      process.stdout.write(
        `${serializeJson(await synchronizeSecret(options.configurationEnv), options.json ? undefined : 2)}\n`,
      );
    });

  deployed
    .command("terraform")
    .description("Run Terraform with deployed account and R2 credentials.")
    .allowUnknownOption()
    .argument("[arguments...]", "Terraform arguments")
    .action(async (arguments_: string[]): Promise<void> => {
      const { runTerraform } = await import("./terraform.ts");
      await runTerraform(arguments_);
    });

  program
    .command("eval [case-prefix]")
    .description("Run workflow and confirmation evaluations through Promptfoo (paid requests).")
    .option("--suite <suite>", "all, workflows, or confirmations", "all")
    .addHelpText(
      "after",
      `
Uses OPENAI_API_KEY or the existing key in apps/api/.dev.vars.local.
Run migrations first. Paid usage shares the application's allowance.
Results stay in the Promptfoo viewer and evals/results/<run-id>/results.json.
Progress and library logs go to stderr; --json emits one compact result on stdout.
Failed assertions, provider errors, or unresolved usage exit with code 1.

Examples:
  pnpm --silent cli eval --suite workflows 03
  pnpm --silent cli eval --suite confirmations dallas-fragmented --json`,
    )
    .action(async (prefix: string | undefined, _options: unknown, command: Command): Promise<void> => {
      const options = z
        .object({ suite: z.enum(["all", "workflows", "confirmations"]), json: z.boolean().default(false) })
        .parse(command.optsWithGlobals());
      const { runEvaluations } = await import("./evaluation.ts");

      await runEvaluations({ ...options, prefix });
    });

  try {
    await program.parseAsync(arguments_, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return;
    }

    const failure =
      error instanceof CommandError
        ? error
        : error instanceof CommanderError
          ? new CommandError(
              "usage_invalid",
              error.message.replace(/^error: /, ""),
              "Run pnpm --silent cli --help or <command> --help.",
              2,
            )
          : error instanceof z.ZodError
            ? new CommandError(
                "usage_invalid",
                error.issues
                  .map((issue): string => `${issue.path.join(".") || "argument"}: ${issue.message}`)
                  .join("; "),
                "Check arguments with <command> --help.",
                2,
              )
            : new CommandError(
                "command_failed",
                error instanceof Error ? error.message : "Command failed.",
                "Run <command> --help and check the command's local prerequisites.",
              );

    const result = { error: { code: failure.code, message: failure.message, hint: failure.hint } };

    process.stderr.write(
      `${arguments_.includes("--json") ? serializeJson(result) : `${failure.code}: ${failure.message}\n${failure.hint}`}\n`,
    );
    process.exitCode = failure.exitCode;
  }
}
