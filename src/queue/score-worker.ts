import { UnrecoverableError, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { emails, jobFailures } from "../db/schema.js";
import type { Logger } from "../lib/logger.js";
import { processEmail, type ProcessOutcome } from "../pipeline/process-email.js";
import type { LlmProvider } from "../scoring/provider.js";
import { ScoreParseError } from "../scoring/scorer.js";
import { backoffDelay, DEFAULT_BACKOFF, isRetryable, type BackoffOptions } from "./retry.js";
import { fromJobData, SCORE_QUEUE, type ScoreJobData } from "./score-queue.js";

export interface ScoreWorkerOptions {
  connection: Redis;
  db: Database;
  provider: LlmProvider;
  log: Logger;
  /** Max jobs started per `rateLimitDurationMs`. Production: LLM_RATE_LIMIT_PER_MIN per minute. */
  rateLimit: number;
  rateLimitDurationMs?: number;
  concurrency?: number;
  backoff?: BackoffOptions;
  prefix?: string;
}

/**
 * The BullMQ worker around `processEmail`.
 *
 * Its own job is failure handling:
 * - **Retryable** errors are rethrown as-is; BullMQ schedules the next
 *   attempt using `backoffDelay`, which honours the provider's `retryAfterMs`.
 * - **Non-retryable** errors (bad API key, model output invalid even after a
 *   re-prompt, missing criteria) become `UnrecoverableError`, which makes
 *   BullMQ fail the job now instead of burning the remaining attempts.
 * - On the **final** failure, either way, a `job_failures` row is written
 *   before the error propagates. That happens inside the processor, not in a
 *   `failed` event handler, so it's awaited: when BullMQ marks the job
 *   failed, the dead-letter row already exists.
 *
 * ## Rate limiting
 * BullMQ's limiter caps jobs *started* per window, across every worker on
 * the queue, which is the right shape for a provider quota. Two caveats,
 * both deliberate:
 * - Filtered emails count against it although they make no LLM call. Rule
 *   filtering is in-process and fast, so this costs a little latency, not
 *   quota; a separate filter queue would fix it at the price of a second hop.
 * - A re-prompt makes a second call inside one job, so a run of bad replies
 *   can briefly exceed the limit by one per job. Rare at temperature 0, and a
 *   429 from that is retried like any other.
 */
export function createScoreWorker(options: ScoreWorkerOptions): Worker<ScoreJobData, ProcessOutcome> {
  const { connection, db, provider, log } = options;
  const backoff = options.backoff ?? DEFAULT_BACKOFF;

  const processor = async (job: Job<ScoreJobData, ProcessOutcome>): Promise<ProcessOutcome> => {
    const email = fromJobData(job.data);
    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;

    try {
      return await processEmail(email, { db, provider, log });
    } catch (err) {
      const retryable = isRetryable(err);
      const final = !retryable || attempt >= maxAttempts;
      const context = { gmailId: email.gmailId, attempt, maxAttempts, err };

      if (!final) {
        log.warn(context, "scoring attempt failed, will retry");
        throw err;
      }

      log.error(context, "scoring failed permanently, dead-lettering");
      await recordFailure(db, email.gmailId, err, attempt).catch((dlqErr: unknown) => {
        // Losing the dead-letter row is bad, but masking the original error
        // would be worse: log both and let the job fail with the real cause.
        log.error({ gmailId: email.gmailId, err: dlqErr }, "could not write job_failures row");
      });

      if (!retryable) throw new UnrecoverableError(errorMessage(err));
      throw err;
    }
  };

  const worker = new Worker<ScoreJobData, ProcessOutcome>(SCORE_QUEUE, processor, {
    connection,
    ...(options.prefix && { prefix: options.prefix }),
    concurrency: options.concurrency ?? 2,
    limiter: { max: options.rateLimit, duration: options.rateLimitDurationMs ?? 60_000 },
    settings: {
      backoffStrategy: (attemptsMade, _type, err) => backoffDelay(attemptsMade, err, backoff),
    },
  });

  // Connection-level errors. Without a listener, Node treats an 'error'
  // event as unhandled and crashes the process.
  worker.on("error", (err) => log.error({ err }, "worker error"));
  return worker;
}

async function recordFailure(db: Database, gmailId: string, err: unknown, attempts: number) {
  const [row] = await db.select({ id: emails.id }).from(emails).where(eq(emails.gmailId, gmailId));
  await db.insert(jobFailures).values({
    emailId: row?.id ?? null,
    gmailId,
    queue: SCORE_QUEUE,
    error: describeFailure(err),
    attempts,
    lastAttemptAt: new Date(),
  });
}

/** The error text stored in job_failures: name, message, and the model's raw reply when that was the problem. */
function describeFailure(err: unknown): string {
  const base = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (err instanceof ScoreParseError) {
    return `${base}\n--- raw model output ---\n${err.raw.slice(0, 2000)}`;
  }
  return base;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
