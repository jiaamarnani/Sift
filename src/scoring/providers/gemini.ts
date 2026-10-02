import {
  postJson,
  ProviderError,
  type CompletionRequest,
  type JsonSchema,
  type LlmProvider,
} from "../provider.js";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Finish reasons that mean Google refused the content; retrying won't help. */
const BLOCKED_FINISH_REASONS = new Set([
  "SAFETY",
  "PROHIBITED_CONTENT",
  "BLOCKLIST",
  "SPII",
  "RECITATION",
]);

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
}

export interface GeminiConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * Gemini via the REST `generateContent` endpoint.
 *
 * Plain `fetch` rather than the @google/genai SDK: this is one POST, and
 * skipping the SDK keeps the dependency tree and the mocking surface small.
 *
 * The key goes in the `x-goog-api-key` header, not the `?key=` query
 * parameter, so it never ends up in a logged URL or an error message.
 */
export function createGeminiProvider(config: GeminiConfig): LlmProvider {
  const url = `${API_BASE}/models/${encodeURIComponent(config.model)}:generateContent`;

  return {
    name: "gemini",
    model: config.model,

    async complete(request: CompletionRequest): Promise<string> {
      const body = {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(request.schema),
        },
      };

      const data = (await postJson("gemini", url, body, {
        headers: { "x-goog-api-key": config.apiKey },
        timeoutMs: config.timeoutMs,
        retryAfterFromBody: parseRetryDelay,
      })) as GeminiResponse;

      const blockReason = data.promptFeedback?.blockReason;
      if (blockReason) {
        throw new ProviderError(`gemini blocked the prompt (${blockReason})`, "gemini", false);
      }

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (text.trim() === "") {
        const reason = candidate?.finishReason ?? "no candidates";
        throw new ProviderError(
          `gemini returned no text (finishReason: ${reason})`,
          "gemini",
          !BLOCKED_FINISH_REASONS.has(reason),
        );
      }
      return text;
    },
  };
}

/**
 * Pull the wait out of a Google error body. Quota 429s carry a
 * `google.rpc.RetryInfo` detail like `{"retryDelay": "32.85s"}`; nothing else
 * in the body is reliable to parse (the human-readable message has changed
 * wording before).
 */
export function parseRetryDelay(body: string): number | undefined {
  let details: unknown;
  try {
    details = (JSON.parse(body) as { error?: { details?: unknown } }).error?.details;
  } catch {
    return undefined;
  }
  if (!Array.isArray(details)) return undefined;

  for (const detail of details) {
    const delay = (detail as { retryDelay?: unknown })?.retryDelay;
    const match = typeof delay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(delay) : null;
    if (match) return Math.ceil(Number(match[1]) * 1000);
  }
  return undefined;
}

/**
 * Convert our JSON Schema subset to Gemini's OpenAPI-style `responseSchema`:
 * uppercase type names, `nullable: true` instead of a `null` type, and an
 * explicit `propertyOrdering` so the model emits fields in declaration order.
 * Gemini otherwise orders them alphabetically, and the scoring schema is
 * deliberately ordered so the model writes its `reason` before the `score`.
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const [type, nullable] = Array.isArray(schema.type) ? [schema.type[0], true] : [schema.type, false];

  const out: Record<string, unknown> = { type: type.toUpperCase() };
  if (nullable) out.nullable = true;
  if (schema.description !== undefined) out.description = schema.description;
  if (schema.enum !== undefined) out.enum = schema.enum;
  if (schema.minimum !== undefined) out.minimum = schema.minimum;
  if (schema.maximum !== undefined) out.maximum = schema.maximum;
  if (schema.properties !== undefined) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
    );
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required !== undefined) out.required = schema.required;
  return out;
}
