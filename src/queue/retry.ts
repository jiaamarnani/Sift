/**
 * Retry policy for the score queue: which errors are worth retrying, and how
 * long to wait between attempts.
 */

export interface BackoffOptions {
  /** Delay before the first retry; doubles each attempt. */
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 5_000, maxMs: 10 * 60_000 };

/**
 * Errors carry their own verdict: ProviderError, ScoreParseError and
 * MissingCriteriaError all expose `retryable`. Anything without one — a
 * Postgres connection reset, a Redis timeout — is assumed transient, because
 * retrying a real bug costs four wasted attempts while dead-lettering a blip
 * loses an email.
 */
export function isRetryable(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "retryable" in err) {
    return (err as { retryable: unknown }).retryable !== false;
  }
  return true;
}

/**
 * Delay before the next attempt.
 *
 * If the provider said how long to wait (`retryAfterMs`, from Gemini's 429
 * body or a Retry-After header), wait exactly that plus a small margin:
 * retrying sooner just spends another request of a 5-per-minute quota on a
 * guaranteed 429. Otherwise exponential backoff with ±20% jitter, so a batch
 * of emails that all hit the same 503 doesn't retry in lockstep.
 *
 * @param attemptsMade  Attempts so far, including the one that just failed (1 on the first retry).
 */
export function backoffDelay(
  attemptsMade: number,
  err: unknown,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const retryAfterMs = (err as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  if (typeof retryAfterMs === "number" && retryAfterMs >= 0) {
    return Math.min(retryAfterMs + 250, options.maxMs);
  }

  const exponential = options.baseMs * 2 ** Math.max(0, attemptsMade - 1);
  const jitter = 0.8 + random() * 0.4;
  return Math.round(Math.min(exponential, options.maxMs) * jitter);
}
