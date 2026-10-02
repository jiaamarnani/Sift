import { randomUUID } from "node:crypto";
import { QueueEvents, type Job, type Queue, type Worker } from "bullmq";
import type { Redis } from "ioredis";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { closeDb, db } from "../../src/db/client.js";
import { emails, feedback, jobFailures, userCriteria } from "../../src/db/schema.js";
import { DEFAULT_CRITERIA } from "../../src/db/seed.js";
import type { TriageEmail } from "../../src/core/types.js";
import { childLogger } from "../../src/lib/logger.js";
import { processEmail, type ProcessOutcome } from "../../src/pipeline/process-email.js";
import {
  createRedisConnection,
  createScoreQueue,
  enqueueEmail,
  jobIdFor,
  type ScoreJobData,
} from "../../src/queue/score-queue.js";
import { createScoreWorker } from "../../src/queue/score-worker.js";
import { ProviderError, type CompletionRequest, type LlmProvider } from "../../src/scoring/provider.js";

/**
 * The whole worker path against real Postgres and Redis, with only the LLM
 * faked. These are the guarantees unit tests can't show: that BullMQ really
 * retries with our backoff, that ON CONFLICT really dedupes, that the
 * dead-letter row really lands, and that the limiter really holds jobs back.
 */

// Every test truncates tables. Refuse to run against anything but the test DB.
if (!env.DATABASE_URL.endsWith("/sifter_test")) {
  throw new Error(`integration tests must run against sifter_test, got ${env.DATABASE_URL}`);
}

const log = childLogger("pipeline-test");

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

let emailSeq = 0;

/** An email that passes the rule filter and goes to the LLM. */
function email(overrides: Partial<TriageEmail> = {}): TriageEmail {
  emailSeq += 1;
  return {
    gmailId: `int_${emailSeq}_${randomUUID().slice(0, 8)}`,
    threadId: null,
    sender: "Jane Recruiter <jane@corp.com>",
    senderEmail: "jane@corp.com",
    subject: "Interview for the SWE co-op",
    bodySnippet: "Are you free Thursday at 2pm?",
    receivedAt: new Date("2026-09-29T12:00:00Z"),
    headers: {},
    ...overrides,
  };
}

function modelReply(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    reason: "Recruiter wants to schedule a co-op interview.",
    category: "interview_request",
    score: 9,
    isTimeSensitive: true,
    deadline: "2026-10-01T18:00:00Z",
    ...overrides,
  });
}

/**
 * A fake LLM that replies from a script, one entry per call (the last entry
 * repeats), and records every request with a timestamp.
 */
function scriptedProvider(...replies: (string | Error)[]) {
  const script = replies.length > 0 ? replies : [modelReply()];
  const calls: { at: number; request: CompletionRequest }[] = [];
  const provider: LlmProvider = {
    name: "ollama",
    model: "fake",
    async complete(request) {
      calls.push({ at: Date.now(), request });
      const reply = script[Math.min(calls.length - 1, script.length - 1)]!;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { provider, calls };
}

const transient = () => new ProviderError("gemini returned HTTP 503: high demand", "gemini", true, 503);

/* ---------------------------------------------------------------------------
 * Harness: one queue + worker + events listener per test, under a unique
 * Redis prefix so tests can't see each other's jobs.
 * ------------------------------------------------------------------------- */

interface Harness {
  queue: Queue<ScoreJobData>;
  worker: Worker<ScoreJobData, ProcessOutcome>;
  events: QueueEvents;
  connections: Redis[];
}

let harness: Harness | null = null;

async function startWorker(
  provider: LlmProvider,
  options: { attempts?: number; rateLimit?: number; rateLimitDurationMs?: number; concurrency?: number } = {},
): Promise<Harness> {
  const prefix = `sifter-test-${randomUUID()}`;
  const connections = [createRedisConnection(), createRedisConnection(), createRedisConnection()];
  const [queueConn, workerConn, eventsConn] = connections as [Redis, Redis, Redis];

  const queue = createScoreQueue(queueConn, {
    prefix,
    jobOptions: options.attempts ? { attempts: options.attempts } : {},
  });
  const events = new QueueEvents(queue.name, { connection: eventsConn, prefix });
  await events.waitUntilReady();

  const worker = createScoreWorker({
    connection: workerConn,
    db,
    provider,
    log,
    prefix,
    rateLimit: options.rateLimit ?? 1000,
    rateLimitDurationMs: options.rateLimitDurationMs ?? 1000,
    concurrency: options.concurrency ?? 2,
    // Fast backoff so retry tests take milliseconds, not minutes.
    backoff: { baseMs: 50, maxMs: 2000 },
  });
  await worker.waitUntilReady();

  harness = { queue, worker, events, connections };
  return harness;
}

async function run(h: Harness, e: TriageEmail): Promise<ProcessOutcome> {
  const job: Job<ScoreJobData> = await enqueueEmail(h.queue, e);
  return job.waitUntilFinished(h.events, 20_000);
}

async function emailRow(gmailId: string) {
  const [row] = await db.select().from(emails).where(eq(emails.gmailId, gmailId));
  return row;
}

beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE ${emails}, ${feedback}, ${jobFailures}, ${userCriteria} RESTART IDENTITY CASCADE`,
  );
  await db.insert(userCriteria).values(DEFAULT_CRITERIA);
});

afterEach(async () => {
  if (!harness) return;
  const h = harness;
  harness = null;
  await h.worker.close(true);
  await h.events.close();
  await h.queue.obliterate({ force: true });
  await h.queue.close();
  await Promise.all(h.connections.map((c) => c.quit()));
});

afterAll(async () => {
  await closeDb();
});

/* ---------------------------------------------------------------------------
 * Happy paths
 * ------------------------------------------------------------------------- */

describe("filter → score → persist", () => {
  it("scores an email and writes every scoring column", async () => {
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    const e = email();

    const outcome = await run(h, e);

    expect(outcome).toMatchObject({ status: "scored", score: 9, category: "interview_request" });
    expect(calls).toHaveLength(1);

    const row = await emailRow(e.gmailId);
    expect(row).toMatchObject({
      senderEmail: "jane@corp.com",
      subject: "Interview for the SWE co-op",
      filteredByRule: null,
      score: 9,
      category: "interview_request",
      reason: "Recruiter wants to schedule a co-op interview.",
      isTimeSensitive: true,
      deadline: new Date("2026-10-01T18:00:00Z"),
      notified: false,
    });
    expect(row?.llmLatencyMs).toBeGreaterThanOrEqual(0);
    expect(row?.processedAt).toBeInstanceOf(Date);
  });

  it("records a filtered email without calling the LLM", async () => {
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    const e = email({
      sender: "The Weekly <hello@weekly.example>",
      senderEmail: "hello@weekly.example",
      subject: "This week's top stories",
      bodySnippet: "Read more on our site.",
      headers: { "list-unsubscribe": "<mailto:unsub@weekly.example>" },
    });

    const outcome = await run(h, e);

    expect(outcome).toMatchObject({ status: "filtered", rule: "newsletter" });
    expect(calls).toHaveLength(0);
    const row = await emailRow(e.gmailId);
    expect(row).toMatchObject({ filteredByRule: "newsletter", score: null });
    expect(row?.processedAt).toBeInstanceOf(Date);
  });
});

/* ---------------------------------------------------------------------------
 * Sender history in the prompt
 * ------------------------------------------------------------------------- */

describe("sender history", () => {
  it("includes the sender's earlier scored mail and feedback, and nothing else", async () => {
    const at = (iso: string) => new Date(iso);
    const base = { sender: "Jane <jane@corp.com>", senderEmail: "jane@corp.com", processedAt: at("2026-09-28T00:00:00Z") };

    const [earlier] = await db
      .insert(emails)
      .values({ ...base, gmailId: "h1", subject: "Coffee chat about roles?", receivedAt: at("2026-09-20T10:00:00Z"), score: 8, category: "recruiting" })
      .returning({ id: emails.id });
    await db.insert(feedback).values({ emailId: earlier!.id, value: "down", source: "api" });

    await db.insert(emails).values([
      // Same sender but filtered: no score, so not history.
      { ...base, gmailId: "h2", subject: "Filtered blast", receivedAt: at("2026-09-21T10:00:00Z"), filteredByRule: "newsletter" },
      // Same sender, but arrived *after* the email being scored.
      { ...base, gmailId: "h3", subject: "From the future", receivedAt: at("2026-09-30T10:00:00Z"), score: 5, category: "recruiting" },
      // Different sender.
      { gmailId: "h4", sender: "x", senderEmail: "other@corp.com", subject: "Someone else", receivedAt: at("2026-09-22T10:00:00Z"), score: 7, processedAt: at("2026-09-22T10:00:00Z") },
    ]);

    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    await run(h, email());

    const user = calls[0]!.request.user;
    expect(user).toContain("- 2026-09-20 | score 8 | recruiting | feedback: down | subject: Coffee chat about roles?");
    expect(user).not.toContain("Filtered blast");
    expect(user).not.toContain("From the future");
    expect(user).not.toContain("Someone else");
  });

  it("tells the model when the sender is new", async () => {
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    await run(h, email({ senderEmail: "brand-new@corp.com" }));
    expect(calls[0]!.request.user).toContain("(no earlier email from this sender)");
  });
});

/* ---------------------------------------------------------------------------
 * Idempotency
 * ------------------------------------------------------------------------- */

describe("idempotency on gmail_id", () => {
  it("dedupes in Redis: enqueuing the same email twice runs one job", async () => {
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    const e = email();

    const [first, second] = await Promise.all([enqueueEmail(h.queue, e), enqueueEmail(h.queue, e)]);
    expect(first.id).toBe(jobIdFor(e.gmailId));
    expect(second.id).toBe(first.id);

    await first.waitUntilFinished(h.events, 20_000);
    expect(calls).toHaveLength(1);
  });

  it("dedupes in Postgres: a replay after the job is gone makes no LLM call and writes nothing", async () => {
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider);
    const e = email();

    await run(h, e);
    const before = await emailRow(e.gmailId);
    await h.queue.remove(jobIdFor(e.gmailId)); // as removeOnComplete eventually would

    const replay = await run(h, e);

    expect(replay).toEqual({ status: "duplicate", emailId: before!.id });
    expect(calls).toHaveLength(1);
    expect(await emailRow(e.gmailId)).toEqual(before);
    expect(await db.$count(emails)).toBe(1);
  });

  it("lets only one of two racing jobs write the result", async () => {
    // Bypasses Redis dedupe on purpose: two workers processing the same
    // message at once is the case only the conditional UPDATE can catch.
    const slow: LlmProvider = {
      name: "ollama",
      model: "fake",
      complete: () => new Promise((resolve) => setTimeout(() => resolve(modelReply()), 100)),
    };
    const e = email();
    const outcomes = await Promise.all([
      processEmail(e, { db, provider: slow, log }),
      processEmail(e, { db, provider: slow, log }),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(["duplicate", "scored"]);
    expect(await db.$count(emails)).toBe(1);
  });
});

/* ---------------------------------------------------------------------------
 * Retries and backoff
 * ------------------------------------------------------------------------- */

describe("retries", () => {
  it("retries a transient provider error and succeeds, with no dead-letter row", async () => {
    const { provider, calls } = scriptedProvider(transient(), transient(), modelReply({ score: 6 }));
    const h = await startWorker(provider, { attempts: 5 });
    const e = email();

    const outcome = await run(h, e);

    expect(outcome).toMatchObject({ status: "scored", score: 6 });
    expect(calls).toHaveLength(3);
    expect(await db.$count(jobFailures)).toBe(0);
  });

  it("backs off exponentially between attempts", async () => {
    const { provider, calls } = scriptedProvider(transient(), transient(), transient(), modelReply());
    const h = await startWorker(provider, { attempts: 5 });
    await run(h, email());

    const gaps = calls.slice(1).map((c, i) => c.at - calls[i]!.at);
    // base 50ms, doubling, ±20% jitter: ≥40, ≥80, ≥160.
    expect(gaps[0]).toBeGreaterThanOrEqual(40);
    expect(gaps[1]).toBeGreaterThanOrEqual(80);
    expect(gaps[2]).toBeGreaterThanOrEqual(160);
  });

  it("waits the provider's retryAfterMs instead of the exponential delay", async () => {
    const rateLimited = new ProviderError("gemini returned HTTP 429", "gemini", true, 429, 600);
    const { provider, calls } = scriptedProvider(rateLimited, modelReply());
    const h = await startWorker(provider, { attempts: 5 });

    await run(h, email());

    expect(calls).toHaveLength(2);
    // Exponential would have been ~50ms.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThanOrEqual(600);
  });

  it("dead-letters after the last attempt, leaving the email unprocessed", async () => {
    const { provider, calls } = scriptedProvider(transient());
    const h = await startWorker(provider, { attempts: 3 });
    const e = email();

    await expect(run(h, e)).rejects.toThrow(/503/);

    expect(calls).toHaveLength(3);
    const row = await emailRow(e.gmailId);
    expect(row?.processedAt).toBeNull();

    const failures = await db.select().from(jobFailures);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      emailId: row!.id,
      gmailId: e.gmailId,
      queue: "score-email",
      attempts: 3,
      error: expect.stringContaining("ProviderError: gemini returned HTTP 503"),
    });
  });

  it("does not retry a non-retryable provider error", async () => {
    const badKey = new ProviderError("gemini returned HTTP 401: API key not valid", "gemini", false, 401);
    const { provider, calls } = scriptedProvider(badKey);
    const h = await startWorker(provider, { attempts: 5 });
    const e = email();

    await expect(run(h, e)).rejects.toThrow(/401/);

    expect(calls).toHaveLength(1);
    const [failure] = await db.select().from(jobFailures);
    expect(failure).toMatchObject({ gmailId: e.gmailId, attempts: 1 });
  });

  it("dead-letters immediately when user_criteria is missing", async () => {
    await db.delete(userCriteria);
    const { provider, calls } = scriptedProvider();
    const h = await startWorker(provider, { attempts: 5 });

    await expect(run(h, email())).rejects.toThrow(/db:seed/);

    expect(calls).toHaveLength(0);
    const [failure] = await db.select().from(jobFailures);
    expect(failure).toMatchObject({ attempts: 1, error: expect.stringContaining("MissingCriteriaError") });
  });
});

/* ---------------------------------------------------------------------------
 * Invalid model output: re-prompt once, then dead-letter
 * ------------------------------------------------------------------------- */

describe("invalid LLM output", () => {
  it("re-prompts once and stores the corrected score", async () => {
    const { provider, calls } = scriptedProvider("not json", modelReply({ score: 3, category: "marketing" }));
    const h = await startWorker(provider);
    const e = email();

    const outcome = await run(h, e);

    expect(outcome).toMatchObject({ status: "scored", score: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.request.user).toContain("Your previous reply could not be used");
    expect(await emailRow(e.gmailId)).toMatchObject({ score: 3, category: "marketing" });
  });

  it("dead-letters after the re-prompt also fails, without queue retries, keeping the raw output", async () => {
    const { provider, calls } = scriptedProvider("not json", '{"score": 42}');
    const h = await startWorker(provider, { attempts: 5 });
    const e = email();

    await expect(run(h, e)).rejects.toThrow(/ScoreParseError/);

    // Two calls (original + re-prompt), not 2 × 5 attempts.
    expect(calls).toHaveLength(2);
    const [failure] = await db.select().from(jobFailures);
    expect(failure).toMatchObject({ gmailId: e.gmailId, attempts: 1 });
    expect(failure?.error).toContain("ScoreParseError: model output failed validation");
    expect(failure?.error).toContain('--- raw model output ---\n{"score": 42}');
    expect((await emailRow(e.gmailId))?.processedAt).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * Rate limiting
 * ------------------------------------------------------------------------- */

describe("rate limiter", () => {
  it("starts no more than LLM_RATE_LIMIT_PER_MIN jobs per window", async () => {
    const { provider, calls } = scriptedProvider();
    // 2 per second stands in for 5 per minute.
    const h = await startWorker(provider, { rateLimit: 2, rateLimitDurationMs: 1000, concurrency: 5 });

    const batch = [1, 2, 3, 4].map((i) => email({ senderEmail: `sender${i}@corp.com` }));
    const jobs = await Promise.all(batch.map((e) => enqueueEmail(h.queue, e)));
    await Promise.all(jobs.map((j) => j.waitUntilFinished(h.events, 20_000)));

    const times = calls.map((c) => c.at).sort((a, b) => a - b);
    expect(times).toHaveLength(4);
    // The third call has to wait for the next window.
    expect(times[2]! - times[0]!).toBeGreaterThanOrEqual(900);
  });
});
