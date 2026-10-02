import { z } from "zod";
import type { ScoringCriteria, SenderHistoryEntry, TriageEmail } from "../core/types.js";
import { buildScoringPrompt, FALLBACK_CATEGORY } from "./prompt.js";
import type { LlmProvider, ProviderName } from "./provider.js";

/** Maps 1:1 onto the scoring columns of the `emails` table. */
export interface ScoreResult {
  category: string;
  score: number;
  reason: string;
  isTimeSensitive: boolean;
  deadline: Date | null;
  llmLatencyMs: number;
  provider: ProviderName;
  model: string;
}

/**
 * The model answered, but not with something we can store — even after
 * `scoreEmail` re-prompted it once.
 *
 * Not retryable: the re-prompt already was the retry. A model that fails the
 * same prompt twice at temperature 0 will keep failing it, so the job goes
 * straight to the dead-letter table, with `raw` attached for debugging.
 */
export class ScoreParseError extends Error {
  override readonly name = "ScoreParseError";
  readonly retryable = false;

  constructor(
    message: string,
    /** The raw model output, for the dead-letter row. */
    readonly raw: string,
  ) {
    super(message);
  }
}

const MAX_REASON_CHARS = 300;

/**
 * Validation of what the model returned. Structured output makes this
 * redundant on a good day; it's here because "the provider promised" is not a
 * guarantee, and a score of 11 or a missing `reason` must fail loudly here
 * rather than land in the database.
 */
const modelOutput = z.object({
  reason: z.string().trim().min(1),
  category: z.string().trim(),
  score: z.number().int().min(1).max(10),
  isTimeSensitive: z.boolean(),
  deadline: z.string().nullable().optional(),
});

/**
 * Score one email with whichever provider is passed in.
 *
 * The provider is a parameter rather than a module-level singleton so tests
 * inject a fake and the worker builds the real one once at startup.
 *
 * If the first reply is unusable, the model is asked once more with the
 * validation error appended. That fixes the common failures (a missing field,
 * a score of 0) for one extra call; a second bad reply throws ScoreParseError.
 * `llmLatencyMs` covers both calls, since that's the time the email waited.
 */
export async function scoreEmail(
  email: TriageEmail,
  criteria: ScoringCriteria,
  provider: LlmProvider,
  history: readonly SenderHistoryEntry[] = [],
): Promise<ScoreResult> {
  const prompt = buildScoringPrompt(email, criteria, history);

  const started = performance.now();
  let parsed: ReturnType<typeof parseModelOutput>;
  try {
    parsed = parseModelOutput(await provider.complete(prompt), prompt.categories);
  } catch (err) {
    if (!(err instanceof ScoreParseError)) throw err;
    const retry = { ...prompt, user: `${prompt.user}\n\n${repairInstruction(err)}` };
    parsed = parseModelOutput(await provider.complete(retry), prompt.categories);
  }
  const llmLatencyMs = Math.round(performance.now() - started);

  return {
    ...parsed,
    llmLatencyMs,
    provider: provider.name,
    model: provider.model,
  };
}

/** Exported for tests. */
export function parseModelOutput(
  raw: string,
  categories: readonly string[],
): Pick<ScoreResult, "category" | "score" | "reason" | "isTimeSensitive" | "deadline"> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch {
    throw new ScoreParseError("model output is not valid JSON", raw);
  }

  const result = modelOutput.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ScoreParseError(`model output failed validation: ${issues}`, raw);
  }
  const out = result.data;

  return {
    // A wrong category is recoverable, a lost score is not: fall back rather
    // than failing the whole email over a label.
    category: categories.includes(out.category) ? out.category : FALLBACK_CATEGORY,
    score: out.score,
    reason: out.reason.slice(0, MAX_REASON_CHARS),
    isTimeSensitive: out.isTimeSensitive,
    deadline: parseDeadline(out.deadline),
  };
}

/**
 * Appended to the user turn on the re-prompt. Names the problem but doesn't
 * echo the bad reply back: it may be long, and repeating it tends to anchor
 * the model on the same mistake.
 */
function repairInstruction(err: ScoreParseError): string {
  return (
    `Your previous reply could not be used (${err.message}). ` +
    "Reply again with only a JSON object that matches the schema exactly."
  );
}

/** An unparseable deadline is dropped, not fatal — it's a bonus field. */
function parseDeadline(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Some local models wrap JSON in ```json fences despite the format constraint. */
function stripCodeFence(text: string): string {
  const match = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return match?.[1] ?? text.trim();
}
