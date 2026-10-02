import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Redis } from "ioredis";
import pg from "pg";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "../../vitest.integration.config.js";

/**
 * Runs once before the integration suite: check the containers are up,
 * create `sifter_test` if it doesn't exist, and apply migrations to it.
 */
export default async function setup() {
  const testDbName = new URL(TEST_DATABASE_URL).pathname.slice(1);
  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Postgres isn't reachable at ${adminUrl.host}. Start it with \`docker compose up -d --wait\`.\n${String(err)}`,
    );
  }
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [testDbName]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${testDbName}"`);
  } finally {
    await admin.end();
  }

  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  } finally {
    await pool.end();
  }

  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
  try {
    await redis.connect();
    await redis.ping();
  } catch (err) {
    throw new Error(
      `Redis isn't reachable at ${TEST_REDIS_URL}. Start it with \`docker compose up -d --wait\`.\n${String(err)}`,
    );
  } finally {
    redis.disconnect();
  }
}
