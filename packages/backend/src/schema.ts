import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { State } from "./model";

export const revision = sqliteTable("revision", {
  id: integer().primaryKey(),
  version: integer().notNull(),
});

export const guard = sqliteTable(
  "guard",
  { id: text().primaryKey(), valid: integer().notNull() },
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
    check("revision_conflict", sql`${table.valid} = 1`),
  ],
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
    data: text({ mode: "json" }).$type<State["negotiations"][number]>().notNull(),
  },
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
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
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
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
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
    uniqueIndex("distinct_price")
      .on(sql`json_extract(${table.data}, '$.pairId')`, sql`json_extract(${table.data}, '$.amountCents')`)
      .where(sql`json_extract(${table.data}, '$.consumed') = 1`),
  ],
);

export const analysis = sqliteTable("analysis", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["analysis"][number]>().notNull(),
});

export const spendingPeriods = sqliteTable(
  "spendingPeriods",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["spendingPeriods"][number]>().notNull(),
  },
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
    check(
      "spending_microdollars",
      sql`json_extract(${table.data}, '$.spentMicrodollars') >= 0 AND typeof(json_extract(${table.data}, '$.spentMicrodollars')) = 'integer'`,
    ),
  ],
);

export const reservations = sqliteTable(
  "reservations",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["reservations"][number]>().notNull(),
  },
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
    check(
      "reservation_microdollars",
      sql`json_extract(${table.data}, '$.reservedMicrodollars') >= 0 AND typeof(json_extract(${table.data}, '$.reservedMicrodollars')) = 'integer' AND json_extract(${table.data}, '$.chargedMicrodollars') >= 0 AND typeof(json_extract(${table.data}, '$.chargedMicrodollars')) = 'integer'`,
    ),
    uniqueIndex("reservation_operation").on(
      sql`json_extract(${table.data}, '$.ownerId')`,
      sql`json_extract(${table.data}, '$.operationId')`,
    ),
  ],
);

export const providerUsage = sqliteTable(
  "providerUsage",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["providerUsage"][number]>().notNull(),
  },
  (table): (ReturnType<typeof check> | ReturnType<ReturnType<typeof uniqueIndex>["on"]>)[] => [
    check(
      "usage_microdollars",
      sql`json_extract(${table.data}, '$.costMicrodollars') >= 0 AND typeof(json_extract(${table.data}, '$.costMicrodollars')) = 'integer'`,
    ),
  ],
);

export const liveSessions = sqliteTable("liveSessions", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["liveSessions"][number]>().notNull(),
});

export const transcriptFragments = sqliteTable(
  "transcriptFragments",
  {
    id: text().primaryKey(),
    data: text({ mode: "json" }).$type<State["transcriptFragments"][number]>().notNull(),
  },
  (table): ReturnType<ReturnType<typeof index>["on"]>[] => [
    index("transcript_call").on(sql`json_extract(${table.data}, '$.callId')`),
    index("transcript_call_sequence").on(
      sql`json_extract(${table.data}, '$.callId')`,
      sql`json_extract(${table.data}, '$.sequence')`,
    ),
  ],
);

export const confirmationAttempts = sqliteTable("confirmationAttempts", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["confirmationAttempts"][number]>().notNull(),
});

export const quotaResets = sqliteTable("quotaResets", {
  id: text().primaryKey(),
  data: text({ mode: "json" }).$type<State["quotaResets"][number]>().notNull(),
});
