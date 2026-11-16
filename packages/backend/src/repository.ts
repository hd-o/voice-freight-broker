import { drizzle } from "drizzle-orm/d1";
import * as tables from "./schema";
import { BusinessError, type State } from "./model";

export async function readState(binding: D1Database): Promise<{ version: number; state: State }> {
  const database = drizzle(binding);

  const [
    revision,
    users,
    sessions,
    calls,
    inventory,
    negotiations,
    quotes,
    agreements,
    evidence,
    receipts,
    events,
    analysis,
    spendingPeriods,
    reservations,
    providerUsage,
    liveSessions,
    transcriptFragments,
    confirmationAttempts,
    quotaResets,
  ] = await database.batch([
    database.select().from(tables.revision),
    database.select().from(tables.users),
    database.select().from(tables.sessions),
    database.select().from(tables.calls),
    database.select().from(tables.inventory),
    database.select().from(tables.negotiations),
    database.select().from(tables.quotes),
    database.select().from(tables.agreements),
    database.select().from(tables.evidence),
    database.select().from(tables.receipts),
    database.select().from(tables.events),
    database.select().from(tables.analysis),
    database.select().from(tables.spendingPeriods),
    database.select().from(tables.reservations),
    database.select().from(tables.providerUsage),
    database.select().from(tables.liveSessions),
    database.select().from(tables.transcriptFragments),
    database.select().from(tables.confirmationAttempts),
    database.select().from(tables.quotaResets),
  ]);

  return {
    version: revision[0].version,
    state: {
      quotaResets: quotaResets.map((row): State["quotaResets"][number] => row.data),
      confirmationAttempts: confirmationAttempts.map((row): State["confirmationAttempts"][number] => row.data),
      users: users.map((row): State["users"][number] => row.data),
      sessions: sessions.map((row): State["sessions"][number] => row.data),
      calls: calls.map((row): State["calls"][number] => row.data),
      inventory: inventory.map((row): State["inventory"][number] => row.data),
      negotiations: negotiations.map((row): State["negotiations"][number] => row.data),
      quotes: quotes.map((row): State["quotes"][number] => row.data),
      agreements: agreements.map((row): State["agreements"][number] => row.data),
      evidence: evidence.map((row): State["evidence"][number] => row.data),
      receipts: receipts.map((row): State["receipts"][number] => row.data),
      events: events.map((row): State["events"][number] => row.data),
      analysis: analysis.map((row): State["analysis"][number] => row.data),
      spendingPeriods: spendingPeriods.map((row): State["spendingPeriods"][number] => row.data),
      reservations: reservations.map((row): State["reservations"][number] => row.data),
      providerUsage: providerUsage.map((row): State["providerUsage"][number] => row.data),
      liveSessions: liveSessions.map((row): State["liveSessions"][number] => row.data),
      transcriptFragments: transcriptFragments.map((row): State["transcriptFragments"][number] => row.data),
    } satisfies State,
  };
}

// A revision guard serializes the small demo inventory across both Workers.
// Its CHECK failure rolls back the entire D1 batch, including dependent writes.
export async function transact<T>(binding: D1Database, command: (state: State) => T): Promise<T> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const { state, version } = await readState(binding);
    const originals = structuredClone(state);
    const result = command(state);
    const token = crypto.randomUUID();

    const statements = [
      binding
        .prepare("INSERT INTO guard (id, valid) VALUES (?, (SELECT version = ? FROM revision WHERE id = 1))")
        .bind(token, version),
    ];

    for (const name of Object.keys(state) as (keyof State)[]) {
      const previous = new Map(originals[name].map((row): [string, string] => [row.id, JSON.stringify(row)]));

      for (const row of state[name]) {
        const data = JSON.stringify(row);

        if (previous.get(row.id) !== data) {
          statements.push(
            binding
              .prepare(
                `INSERT INTO ${name} (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
              )
              .bind(row.id, data),
          );
        }

        previous.delete(row.id);
      }

      for (const id of previous.keys()) {
        statements.push(binding.prepare(`DELETE FROM ${name} WHERE id = ?`).bind(id));
      }
    }

    statements.push(binding.prepare("UPDATE revision SET version = version + 1 WHERE id = 1"));

    statements.push(binding.prepare("DELETE FROM guard WHERE id = ?").bind(token));

    try {
      await binding.batch(statements);

      return result;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("revision_conflict")) {
        throw error;
      }
    }
  }

  throw new BusinessError("busy", "Inventory is busy. Retry this operation.", 503);
}
