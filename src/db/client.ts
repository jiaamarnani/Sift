import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env.js";
import * as schema from "./schema.js";

/**
 * One shared connection pool per process.
 *
 * The API server and the worker are separate processes, so each gets its own
 * pool. `max: 10` is deliberately small: Railway/Fly Postgres plans cap total
 * connections, and two processes at 10 each leaves headroom for migrations and
 * a psql session.
 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on("error", (err) => {
  // An idle client erroring out shouldn't take down the process; the pool
  // will replace it. Log it so a flapping database is visible.
  console.error("[db] idle client error", err);
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await pool.end();
}
