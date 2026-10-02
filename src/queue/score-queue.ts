import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import type { TriageEmail } from "../core/types.js";

export const SCORE_QUEUE = "score-email";

/** Job payload: a TriageEmail with the Date flattened, since jobs are stored as JSON. */
export type ScoreJobData = Omit<TriageEmail, "receivedAt"> & { receivedAt: string };

/**
 * Attempts include the first try. With the backoff below that's waits of
 * ~5s, 10s, 20s, 40s: a bit over a minute, which outlasts a 429 on a
 * per-minute quota and most "high demand" 503 spells.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: "custom" },
  // Completed jobs are only kept for debugging; the database is the record.
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * BullMQ needs `maxRetriesPerRequest: null` on worker connections: its
 * blocking commands would otherwise error out after ioredis's default 20
 * retries during a Redis blip, and the worker would stop pulling jobs.
 */
export function createRedisConnection(url: string = env.REDIS_URL): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export interface QueueOptions {
  /** Key prefix in Redis. Tests use a unique one per run so they never touch real jobs. */
  prefix?: string;
  jobOptions?: JobsOptions;
}

export function createScoreQueue(connection: Redis, options: QueueOptions = {}): Queue<ScoreJobData> {
  return new Queue<ScoreJobData>(SCORE_QUEUE, {
    connection,
    ...(options.prefix && { prefix: options.prefix }),
    defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, ...options.jobOptions },
  });
}

/**
 * Enqueue one email for the pipeline.
 *
 * The job id is derived from gmail_id, so enqueuing the same message twice
 * while the first job still exists is a no-op in Redis. That's a cheap first
 * line of defence; the real guarantee is the database (see process-email.ts),
 * because completed jobs are eventually removed and the id frees up.
 */
export async function enqueueEmail(queue: Queue<ScoreJobData>, email: TriageEmail) {
  return queue.add("score", toJobData(email), { jobId: jobIdFor(email.gmailId) });
}

/** Prefixed because BullMQ rejects custom ids that parse as integers. */
export function jobIdFor(gmailId: string): string {
  return `gmail-${gmailId}`;
}

export function toJobData(email: TriageEmail): ScoreJobData {
  return { ...email, receivedAt: email.receivedAt.toISOString() };
}

export function fromJobData(data: ScoreJobData): TriageEmail {
  return { ...data, receivedAt: new Date(data.receivedAt) };
}
