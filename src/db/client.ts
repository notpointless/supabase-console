import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getEnv } from "../config/env";
import * as schema from "./schema";

export const pool = new Pool({ connectionString: getEnv().DATABASE_URL });
export const db = drizzle({ client: pool, schema });
export type DB = typeof db;
