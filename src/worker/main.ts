import { env } from "../config/env.js";
import { closeDb, db } from "../db/client.js";
import { childLogger } from "../lib/logger.js";
import { createRedisConnection } from "../queue/score-queue.js";
import { createScoreWorker } from "../queue/score-worker.js";
import { createProvider } from "../scoring/providers/index.js";

/**
 * Worker process entry point (`npm run dev:worker` / `start:worker`).
 *
 * Builds the provider once, before connecting, so a missing GEMINI_API_KEY
 * crashes at boot rather than on the first job.
 */
const log = childLogger("worker");

const provider = createProvider();
const connection = createRedisConnection();
const worker = createScoreWorker({
  connection,
  db,
  provider,
  log,
  rateLimit: env.LLM_RATE_LIMIT_PER_MIN,
});

log.info(
  { provider: provider.name, model: provider.model, rateLimitPerMin: env.LLM_RATE_LIMIT_PER_MIN },
  "score worker started",
);

/**
 * Graceful shutdown: `worker.close()` waits for in-flight jobs to finish, so
 * a deploy doesn't kill an email mid-score. A second signal forces exit.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    log.warn({ signal }, "forced exit");
    process.exit(1);
  }
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  try {
    await worker.close();
    await connection.quit();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error({ err }, "error during shutdown");
    process.exit(1);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
