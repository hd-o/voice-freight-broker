import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { CommandError } from "./errors.ts";

export const repositoryPath = fileURLToPath(new URL("../../../", import.meta.url));

export type DatabaseOptions = { database?: string; persistTo: string };

export function resolveDatabase(options: DatabaseOptions): string {
  if (options.database) {
    const path = resolve(options.database);

    if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
      throw new CommandError(
        "database_missing",
        `Database file not found: ${path}`,
        "Supply an existing --database file.",
        3,
      );
    }

    return path;
  }

  const directory = resolve(options.persistTo, "v3/d1/miniflare-D1DatabaseObject");
  const files = statSync(directory, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(directory)
        .filter((name): boolean => name.endsWith(".sqlite") && name !== "metadata.sqlite")
        .sort()
    : [];

  if (!files.length) {
    throw new CommandError(
      "database_missing",
      `No local D1 database found in ${directory}`,
      "Run pnpm db:migrate for development storage, or supply --persist-to or --database.",
      3,
    );
  }

  if (files.length > 1) {
    throw new CommandError(
      "database_ambiguous",
      "Multiple local D1 databases found.",
      `Select one with --database: ${files.map((name): string => resolve(directory, name)).join(", ")}`,
      2,
    );
  }

  return resolve(directory, files[0]);
}

export function openDatabase(options: DatabaseOptions): DatabaseSync {
  const database = new DatabaseSync(resolveDatabase(options), { readOnly: true, allowExtension: false, timeout: 1000 });

  // Keep a consistent snapshot across a command's reads, including transcript completion.
  database.exec("BEGIN");

  database.setAuthorizer((action): number => {
    if (
      [constants.SQLITE_READ, constants.SQLITE_SELECT, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE].includes(
        action,
      )
    ) {
      return constants.SQLITE_OK;
    }

    return constants.SQLITE_DENY;
  });

  return database;
}

export function querySchema(database: DatabaseSync, table?: string): { objects: Record<string, SQLOutputValue>[] } {
  const objects = database
    .prepare(
      `SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND (? IS NULL OR tbl_name = ?)
     ORDER BY type, name`,
    )
    .all(table ?? null, table ?? null);

  if (table && !objects.some((object): boolean => object.type === "table" || object.type === "view")) {
    throw new CommandError(
      "table_missing",
      `Table or view not found: ${table}`,
      "Run db schema to list database objects.",
      3,
    );
  }

  return { objects };
}

export function queryDatabase(
  database: DatabaseSync,
  sql: string,
  limit: number,
): {
  columns: string[];
  rows: Record<string, SQLOutputValue>[];
  count: number;
  truncated: boolean;
} {
  let statement;

  try {
    statement = database.prepare(sql);
  } catch (error) {
    if (error instanceof Error && error.message.includes("not authorized")) {
      throw new CommandError(
        "sql_prohibited",
        "Only read-only SELECT statements and CTEs are allowed.",
        "Use the existing migration tools for database changes.",
        2,
      );
    }

    throw new CommandError(
      "sql_invalid",
      error instanceof Error ? error.message : "Invalid SQL.",
      "Check table names with db schema and retry.",
      2,
    );
  }

  if (sql.slice(statement.sourceSQL.length).trim()) {
    throw new CommandError(
      "sql_multiple",
      "Only one SQL statement is allowed.",
      "Run each query as a separate command.",
      2,
    );
  }

  const columns = statement.columns().map((column): string => column.name);

  if (!columns.length) {
    throw new CommandError("sql_invalid", "The query must return columns.", "Supply one SELECT statement or CTE.", 2);
  }

  if (new Set(columns).size !== columns.length) {
    throw new CommandError(
      "sql_columns",
      "Query column names must be unique.",
      "Use AS aliases for duplicate column names.",
      2,
    );
  }

  statement.setReadBigInts(true);
  const rows: Record<string, SQLOutputValue>[] = [];

  for (const row of statement.iterate()) {
    rows.push(row);

    if (rows.length > limit) {
      break;
    }
  }

  const truncated = rows.length > limit;

  if (truncated) {
    rows.pop();
  }

  return { columns, rows, count: rows.length, truncated };
}
