import {
  check,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { State } from "./model";

export const revision = sqliteTable("revision", {
  id: integer().primaryKey(),
  version: integer().notNull(),
});
export const guard = sqliteTable(
  "guard",
  { id: text().primaryKey(), valid: integer().notNull() },
  (table) => [check("revision_conflict", sql`${table.valid} = 1`)],
);
export const users = sqliteTable("users", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["users"][number]>().notNull(),
});
export const sessions = sqliteTable("sessions", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["sessions"][number]>().notNull(),
});
export const calls = sqliteTable("calls", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["calls"][number]>().notNull(),
});
export const inventory = sqliteTable("inventory", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["inventory"][number]>().notNull(),
});
export const negotiations = sqliteTable(
  "negotiations",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" })
      .$type<State["negotiations"][number]>()
      .notNull(),
  },
  (table) => [
    uniqueIndex("negotiation_pair").on(
      sql`json_extract(${table.data}, '$.carrierId')`,
      sql`json_extract(${table.data}, '$.loadId')`,
    ),
  ],
);
export const quotes = sqliteTable("quotes", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["quotes"][number]>().notNull(),
});
export const agreements = sqliteTable(
  "agreements",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["agreements"][number]>().notNull(),
  },
  (table) => [
    uniqueIndex("effective_allocation")
      .on(sql`json_extract(${table.data}, '$.load.id')`)
      .where(sql`json_extract(${table.data}, '$.status') = 'effective'`),
  ],
);
export const evidence = sqliteTable("evidence", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["evidence"][number]>().notNull(),
});
export const receipts = sqliteTable("receipts", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["receipts"][number]>().notNull(),
});
export const events = sqliteTable(
  "events",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["events"][number]>().notNull(),
  },
  (table) => [
    uniqueIndex("distinct_price")
      .on(
        sql`json_extract(${table.data}, '$.pairId')`,
        sql`json_extract(${table.data}, '$.amountCents')`,
      )
      .where(sql`json_extract(${table.data}, '$.consumed') = 1`),
  ],
);
export const analysis = sqliteTable("analysis", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["analysis"][number]>().notNull(),
});
