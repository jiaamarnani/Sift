/**
 * The seam between the scorer and whichever LLM backend is configured.
 *
 * A provider does one thing: send a system + user prompt with a response
 * schema and hand back the model's raw JSON text. It does not parse, validate,
 * or interpret the score — that lives in the scorer, once, so a quirk in one
 * backend's output can't leak into the pipeline as a different-shaped result.
 * Adding a backend means implementing `complete()` and nothing else.
 */

export type ProviderName = "gemini" | "ollama";

type JsonType = "object" | "string" | "integer" | "boolean";

/**
 * The JSON Schema subset both backends can enforce. Ollama takes JSON Schema
 * as-is; Gemini's `responseSchema` is an OpenAPI dialect, which the Gemini
 * provider converts to. Nullable is spelled `["string", "null"]`.
 */
export interface JsonSchema {
  type: JsonType | [JsonType, "null"];
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export interface CompletionRequest {
  system: string;
  user: string;
  /** Structured-output constraint. The scorer still validates the result. */
  schema: JsonSchema;
}

export interface LlmProvider {
  readonly name: ProviderName;
  readonly model: string;
  /** Resolve with the model's raw response text; reject with `ProviderError`. */
  complete(request: CompletionRequest): Promise<string>;
}

/**
 * A failed call to a backend.
 *
 * `retryable` is what the queue worker reads to decide between a BullMQ retry
 * and the dead-letter table: a 429 or a timeout will likely succeed later; a
 * bad API key or an unpulled Ollama model never will, and retrying it five
 * times just delays the failure showing up in /metrics.
 *
 * `retryAfterMs` is set when the backend says how long to wait (Gemini's
 * free tier does, on every 429), so a retry can wait that long instead of
 * guessing and burning another request of a 5-per-minute quota.
 */
export class ProviderError extends Error {
  override readonly name = "ProviderError";

  constructor(
    message: string,
    readonly provider: ProviderName,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** 408, 429 and 5xx are transient; every other 4xx is a config or request bug. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * POST a JSON body and return the parsed JSON response, mapping every failure
 * mode — timeout, connection refused, non-2xx, non-JSON body — to a
 * `ProviderError` so callers have one error type to handle.
 */
export async function postJson(
  provider: ProviderName,
  url: string,
  body: unknown,
  options: {
    headers?: Record<string, string>;
    timeoutMs: number;
    /** Backend-specific: read a retry delay out of an error body. */
    retryAfterFromBody?: (body: string) => number | undefined;
  },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...options.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    const detail = timedOut ? `timed out after ${options.timeoutMs}ms` : describeNetworkError(err);
    throw new ProviderError(`${provider} request ${detail}`, provider, true);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `${provider} returned HTTP ${response.status}: ${truncate(text, 500)}`,
      provider,
      isRetryableStatus(response.status),
      response.status,
      retryAfterFromHeader(response.headers.get("retry-after")) ?? options.retryAfterFromBody?.(text),
    );
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(
      `${provider} returned a non-JSON body: ${truncate(text, 200)}`,
      provider,
      true,
      response.status,
    );
  }
}

/** `Retry-After` in its delay-seconds form; the HTTP-date form isn't used by either backend. */
function retryAfterFromHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** Undici wraps the useful part (ECONNREFUSED etc.) in `cause`. */
function describeNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return `failed: ${String(err)}`;
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `failed: ${err.message}${cause}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
