import "dotenv/config";
import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * `npm run demo`: seed synthetic emails, run them through the real queue and
 * worker, and print what landed in Postgres.
 *
 *   npm run demo            offline: canned model replies, no API key needed
 *   npm run demo -- --live  the provider named by LLM_PROVIDER (synthetic emails only)
 *
 * Needs Postgres and Redis from `docker compose up -d --wait`. Uses its own
 * `sifter_demo` database (created and migrated on first run, wiped on every
 * run) and a throwaway Redis key prefix, so dev data is never touched.
 */

const live = process.argv.includes("--live");

// Point at the demo database before anything imports env.ts / db/client.ts.
const demoDbUrl = new URL(process.env.DATABASE_URL ?? "postgres://sifter:sifter@localhost:5433/sifter");
demoDbUrl.pathname = "/sifter_demo";
process.env.DATABASE_URL = demoDbUrl.toString();
// Pipeline logs would bury the table; the demo prints its own progress.
process.env.LOG_LEVEL = process.env.DEMO_LOG_LEVEL ?? "fatal";

await ensureDatabase(demoDbUrl);

const { desc, sql } = await import("drizzle-orm");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
const { QueueEvents } = await import("bullmq");
const { env } = await import("../config/env.js");
const { closeDb, db } = await import("../db/client.js");
const { emails, feedback, jobFailures, userCriteria } = await import("../db/schema.js");
const { DEFAULT_CRITERIA } = await import("../db/seed.js");
const { childLogger } = await import("../lib/logger.js");
const { createRedisConnection, createScoreQueue, enqueueEmail, jobIdFor, toJobData } = await import(
  "../queue/score-queue.js"
);
const { createScoreWorker } = await import("../queue/score-worker.js");
const { createProvider } = await import("../scoring/providers/index.js");
const { DEMO_EMAILS } = await import("./emails.js");
const { createDemoProvider } = await import("./demo-provider.js");
type LlmProvider = import("../scoring/provider.js").LlmProvider;

await migrate(db, { migrationsFolder: "./drizzle" });
await db.execute(sql`TRUNCATE ${emails}, ${feedback}, ${jobFailures}, ${userCriteria} RESTART IDENTITY CASCADE`);
await db.insert(userCriteria).values(DEFAULT_CRITERIA);

/** Count model calls per email so the table can show re-prompts and retries. */
const callsBySender = new Map<string, number>();
function counting(inner: LlmProvider): LlmProvider {
  return {
    name: inner.name,
    model: inner.model,
    complete(request) {
      const hit = DEMO_EMAILS.find((d) => request.user.includes(d.email.senderEmail));
      if (hit) callsBySender.set(hit.email.senderEmail, (callsBySender.get(hit.email.senderEmail) ?? 0) + 1);
      return inner.complete(request);
    },
  };
}

const provider = counting(live ? createProvider() : createDemoProvider(DEMO_EMAILS));
const prefix = `sifter-demo-${randomUUID()}`;
const [queueConn, workerConn, eventsConn] = [createRedisConnection(), createRedisConnection(), createRedisConnection()];
const queue = createScoreQueue(queueConn, { prefix });
const events = new QueueEvents(queue.name, { connection: eventsConn, prefix });
const worker = createScoreWorker({
  connection: workerConn,
  db,
  provider,
  log: childLogger("demo"),
  prefix,
  // Offline there's no quota to protect, and fast backoff keeps the retry demo quick.
  // Live uses the real limits so a free-tier key isn't burned through.
  rateLimit: live ? env.LLM_RATE_LIMIT_PER_MIN : 1000,
  ...(live ? {} : { backoff: { baseMs: 500, maxMs: 5_000 } }),
});
await Promise.all([events.waitUntilReady(), worker.waitUntilReady()]);

const mode = live ? `live: ${provider.name} / ${provider.model}` : "offline: canned model replies";
console.log(`\nSift demo (${mode})`);
console.log(`Enqueuing ${DEMO_EMAILS.length} synthetic emails…`);
if (live) {
  console.log(`Rate limit is ${env.LLM_RATE_LIMIT_PER_MIN}/min, so this can take a few minutes.`);
}

const timeoutMs = live ? 15 * 60_000 : 60_000;
const failures = new Map<string, string>();
await Promise.all(
  DEMO_EMAILS.map(async ({ email }) => {
    const job = await enqueueEmail(queue, email);
    try {
      await job.waitUntilFinished(events, timeoutMs);
    } catch (err) {
      failures.set(email.gmailId, err instanceof Error ? err.message : String(err));
    }
  }),
);

// Idempotency: replay the first email under a fresh job id, so Redis can't
// dedupe it. The database must, and no model call should happen.
const first = DEMO_EMAILS[0]!.email;
const callsBefore = callsBySender.get(first.senderEmail) ?? 0;
const replay = await queue.add("score", toJobData(first), { jobId: `${jobIdFor(first.gmailId)}-replay` });
const replayOutcome = await replay.waitUntilFinished(events, timeoutMs);
const replayCalls = (callsBySender.get(first.senderEmail) ?? 0) - callsBefore;

const rows = await db
  .select()
  .from(emails)
  .orderBy(sql`${emails.score} DESC NULLS LAST`, desc(emails.filteredByRule));
const [{ count: deadLettered } = { count: 0 }] = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(jobFailures);

printTable(
  ["Score", "Category", "Filtered by", "LLM calls", "LLM ms", "From", "Subject"],
  rows.map((r) => [
    r.score === null ? "–" : String(r.score),
    r.category ?? "–",
    r.filteredByRule ?? (failures.has(r.gmailId) ? "FAILED" : "–"),
    String(callsBySender.get(r.senderEmail) ?? 0),
    r.llmLatencyMs === null ? "–" : String(r.llmLatencyMs),
    r.senderEmail,
    truncate(r.subject ?? "", 44),
  ]),
);

const scored = rows.filter((r) => r.score !== null).length;
const filtered = rows.filter((r) => r.filteredByRule !== null).length;
console.log(
  `\n${rows.length} emails: ${scored} scored, ${filtered} dropped by rules before the LLM, ${deadLettered} dead-lettered.`,
);
console.log(
  `Replayed ${first.gmailId}: outcome "${replayOutcome.status}", ${replayCalls} extra LLM calls (idempotent on gmail_id).`,
);
if (!live) {
  console.log("LLM calls = 2 means a re-prompt after invalid JSON, or a retry after an HTTP 503.");
}
for (const [gmailId, message] of failures) console.log(`  ${gmailId} failed: ${message}`);

await worker.close();
await events.close();
await queue.obliterate({ force: true });
await queue.close();
await Promise.all([queueConn, workerConn, eventsConn].map((c) => c.quit()));
await closeDb();

/* ------------------------------------------------------------------------- */

async function ensureDatabase(url: URL) {
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString(), connectionTimeoutMillis: 3000 });
  try {
    await admin.connect();
  } catch (err) {
    console.error(`Postgres isn't reachable at ${adminUrl.host}. Start it with \`docker compose up -d --wait\`.`);
    console.error(String(err));
    process.exit(1);
  }
  try {
    const name = url.pathname.slice(1);
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (exists.rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}

function printTable(headers: string[], body: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...body.map((row) => row[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(`\n${line(headers)}`);
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
