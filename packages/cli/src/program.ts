import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import { openDatabase, queryDatabase, querySchema, repositoryPath } from "./database.ts";
import { CommandError, serializeJson } from "./errors.ts";
import { formatTranscript, queryTranscript } from "./transcript.ts";

const optionsSchema = z.object({
  database: z.string().trim().min(1).optional(),
  persistTo: z.string().trim().min(1),
  json: z.boolean().default(false),
});

export async function runCli(arguments_: string[]): Promise<void> {
  const program = new Command()
    .name("cli")
    .description("Read-only shortcuts for local freight development and debugging.")
    .option("--json", "emit compact JSON; errors are JSON on stderr")
    .option("--database <file>", "use an existing SQLite file instead of storage discovery")
    .option("--persist-to <directory>", "Wrangler storage directory", resolve(repositoryPath, ".wrangler/state"))
    .showSuggestionAfterError(false)
    .exitOverride()
    .configureOutput({ writeErr: (): void => {} })
    .configureHelp({ showGlobalOptions: true })
    .addHelpText(
      "after",
      `
Usage notes:
  Run from the repository root with the project's Node 26 runtime.
  Commands are local and read-only; no running Workers or credentials needed.
  Help never opens a database. Use existing migration commands for changes.

Database selection:
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
  pnpm --silent cli calls transcript <call-id> --json
  pnpm --silent cli db schema calls
  pnpm --silent cli db query 'SELECT id FROM calls ORDER BY id' --json
  pnpm --silent cli --persist-to .wrangler/stub-workflow db schema
  pnpm --silent cli --database /absolute/path/database.sqlite db schema --json

Exit codes:
  0 success/help; 1 operational failure or invalid stored transcript;
  2 invalid usage, prohibited SQL, or ambiguous database;
  3 missing database, call, table, or view.`,
    );

  const calls = program.command("calls").description("Inspect locally stored calls.");

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
      const options = optionsSchema.parse(command.optsWithGlobals());
      const database = openDatabase(options);

      try {
        const transcript = queryTranscript(database, id);
        process.stdout.write(`${options.json ? serializeJson(transcript) : formatTranscript(transcript)}\n`);
      } finally {
        database.close();
      }
    });

  const db = program.command("db").description("Inspect a local D1 database without changing it.");

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
      const options = optionsSchema.parse(command.optsWithGlobals());
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
      const options = optionsSchema.parse(command.optsWithGlobals());
      const limit = z.coerce.number().int().min(1).max(1000).parse(command.opts().limit);
      const database = openDatabase(options);

      try {
        const result = queryDatabase(database, query, limit);
        process.stdout.write(`${serializeJson(result, options.json ? undefined : 2)}\n`);
      } finally {
        database.close();
      }
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
                "Check the database path, run db schema, and verify local migrations.",
              );

    const result = { error: { code: failure.code, message: failure.message, hint: failure.hint } };

    process.stderr.write(
      `${arguments_.includes("--json") ? serializeJson(result) : `${failure.code}: ${failure.message}\n${failure.hint}`}\n`,
    );
    process.exitCode = failure.exitCode;
  }
}
