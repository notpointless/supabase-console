import { sql } from "drizzle-orm";
import { db } from "../db/client";

export async function isInstalled(): Promise<boolean> {
  const { rows } = await db.execute<{ count: number }>(
    sql`select count(*)::int as count from "user"`,
  );
  return (rows[0]?.count ?? 0) > 0;
}
