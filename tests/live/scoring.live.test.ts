import { describe, expect, it } from "vitest";
import { env } from "../../src/config/env.js";
import { DEFAULT_CRITERIA } from "../../src/db/seed.js";
import { createProvider, ProviderError, scoreEmail } from "../../src/scoring/index.js";
import type { ScoringCriteria, TriageEmail } from "../../src/core/types.js";
import { SAMPLE_EMAILS } from "./sample-emails.js";

/**
 * Opt-in: real calls to whichever provider LLM_PROVIDER selects, using only
 * the synthetic emails in sample-emails.ts. Skipped unless LIVE_LLM=1, so a
 * plain `npm test` never touches the network or spends free-tier quota.
 *
 *   npm run test:live                        # uses LLM_PROVIDER from .env
 *   LLM_PROVIDER=ollama npm run test:live    # local model
 *
 * Calls are spaced to LLM_RATE_LIMIT_PER_MIN (5/min on Gemini's free tier,
 * so the suite takes ~75s), and a retryable failure (a 429 or a 503 "high
 * demand") waits as long as the provider asks and tries again, up to
 * MAX_ATTEMPTS. Without this the suite fails on quota, not on scoring.
 */
const live = process.env.LIVE_LLM === "1";

const MAX_ATTEMPTS = 3;
const SPACING_MS = Math.ceil(60_000 / env.LLM_RATE_LIMIT_PER_MIN);
/** Fallback wait when a retryable error doesn't say how long to wait. */
const DEFAULT_BACKOFF_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let lastCallAt = 0;

/** Block until a call would stay within LLM_RATE_LIMIT_PER_MIN. */
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const wait = lastCallAt + SPACING_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
  return fn();
}

const criteria: ScoringCriteria = {
  prioritySenders: DEFAULT_CRITERIA.prioritySenders ?? [],
  keywords: DEFAULT_CRITERIA.keywords ?? [],
  highPriorityCategories: DEFAULT_CRITERIA.highPriorityCategories ?? [],
  lowPriorityCategories: DEFAULT_CRITERIA.lowPriorityCategories ?? [],
  criteriaPrompt: DEFAULT_CRITERIA.criteriaPrompt ?? "",
};

describe.skipIf(!live)(`live scoring via ${env.LLM_PROVIDER}`, () => {
  const provider = live ? createProvider() : null;

  async function scoreWithRetry(label: string, email: TriageEmail) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await paced(() => scoreEmail(email, criteria, provider!));
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable || attempt >= MAX_ATTEMPTS) throw err;
        const wait = err.retryAfterMs ?? DEFAULT_BACKOFF_MS;
        console.log(`    ${label}: HTTP ${err.status ?? "-"}, retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
      }
    }
  }

  for (const { label, email, expected } of SAMPLE_EMAILS) {
    // Worst case: every attempt times out, plus a full minute of backoff each.
    const timeout = MAX_ATTEMPTS * (env.LLM_TIMEOUT_MS + 60_000) + SPACING_MS;

    it(`${label}: scores ${expected.min}-${expected.max}`, { timeout }, async () => {
      const result = await scoreWithRetry(label, email);

      console.log(
        `[${result.provider}/${result.model}] ${label}: ${result.score}/10 ${result.category} ` +
          `(${result.llmLatencyMs}ms)${result.deadline ? ` deadline=${result.deadline.toISOString()}` : ""}\n` +
          `    ${result.reason}`,
      );

      expect(result.score).toBeGreaterThanOrEqual(expected.min);
      expect(result.score).toBeLessThanOrEqual(expected.max);
    });
  }
});
