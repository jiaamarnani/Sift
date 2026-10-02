import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./client.js";
import { childLogger } from "../lib/logger.js";

/**
 * Apply any pending migrations from ./drizzle.
 *
 * Run as a script (`npm run db:migrate`) locally and as a release command on
 * Railway/Fly, so deploys never start a worker against an older schema.
 * drizzle-orm tracks what's applied in its own `__drizzle_migrations` table,
 * making this safe to run repeatedly.
 */
const log = childLogger("migrate");

async function main() {
  log.info("applying migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  log.info("migrations up to date");
  await closeDb();
}

main().catch(async (err) => {
  log.error({ err }, "migration failed");
  await closeDb().catch(() => {});
  process.exit(1);
});
