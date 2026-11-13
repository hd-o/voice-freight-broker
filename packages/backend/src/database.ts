import { drizzle } from "drizzle-orm/d1";
import { sql } from "drizzle-orm";

export async function checkDatabase(binding: D1Database): Promise<"ready"> {
  const database = drizzle(binding);
  const result = await database.get<{ value: number }>(sql`SELECT 1 AS value`);

  if (result?.value !== 1) {
    throw new Error("Database check failed");
  }

  return "ready";
}
