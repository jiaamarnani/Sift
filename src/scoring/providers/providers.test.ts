import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiProvider, parseRetryDelay, toGeminiSchema } from "./gemini.js";
import { createOllamaProvider } from "./ollama.js";
import { createProvider } from "./index.js";
import type { CompletionRequest } from "../provider.js";

/**
 * Every test here stubs global `fetch`. None of them reach the network — the
 * opt-in live test in tests/live is the only place that does.
 */

const request: CompletionRequest = {
  system: "You triage email.",
  user: "<email>\nSubject: hi\n</email>",
  schema: {
    type: "object",
    properties: {
      reason: { type: "string" },
      score: { type: "integer", minimum: 1, maximum: 10 },
      deadline: { type: ["string", "null"] },
    },
    required: ["reason", "score", "deadline"],
  },
};

const MODEL_JSON = '{"reason":"r","score":5,"deadline":null}';

function stubFetch(...responses: (Response | Error)[]) {
  const mock = vi.fn<typeof fetch>();
  for (const r of responses) {
    if (r instanceof Error) mock.mockRejectedValueOnce(r);
    else mock.mockResolvedValueOnce(r);
  }
  vi.stubGlobal("fetch", mock);
  return mock;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** What undici throws for a refused connection. */
function connectionRefused(): Error {
  return new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:11434") });
}

function timeout(): Error {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** Parse the JSON body of the Nth fetch call. */
function sentBody(mock: ReturnType<typeof stubFetch>, call = 0): Record<string, any> {
  return JSON.parse(String(mock.mock.calls[call]?.[1]?.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ---------------------------------------------------------------------------
 * Gemini
 * ------------------------------------------------------------------------- */

describe("gemini provider", () => {
  const gemini = () => createGeminiProvider({ apiKey: "test-key", model: "gemini-3.5-flash", timeoutMs: 1000 });
  const ok = (text: string) => json({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }] });

  it("posts to generateContent for the configured model and returns the text", async () => {
    const mock = stubFetch(ok(MODEL_JSON));
    await expect(gemini().complete(request)).resolves.toBe(MODEL_JSON);

    const [url] = mock.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    );
  });

  it("sends the API key in a header, never in the URL", async () => {
    const mock = stubFetch(ok(MODEL_JSON));
    await gemini().complete(request);

    const [url, init] = mock.mock.calls[0]!;
    expect(String(url)).not.toContain("test-key");
    expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("sends system, user, JSON mode and the converted schema at temperature 0", async () => {
    const mock = stubFetch(ok(MODEL_JSON));
    await gemini().complete(request);

    const body = sentBody(mock);
    expect(body.systemInstruction).toEqual({ parts: [{ text: request.system }] });
    expect(body.contents).toEqual([{ role: "user", parts: [{ text: request.user }] }]);
    expect(body.generationConfig).toMatchObject({
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: { type: "OBJECT", propertyOrdering: ["reason", "score", "deadline"] },
    });
  });

  it("joins multi-part responses", async () => {
    stubFetch(json({ candidates: [{ content: { parts: [{ text: '{"a":' }, { text: "1}" }] } }] }));
    await expect(gemini().complete(request)).resolves.toBe('{"a":1}');
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
    [404, false],
  ])("marks HTTP %i as retryable=%s", async (status, retryable) => {
    stubFetch(json({ error: { message: "nope" } }, status));
    await expect(gemini().complete(request)).rejects.toMatchObject({
      name: "ProviderError",
      provider: "gemini",
      status,
      retryable,
    });
  });

  it("does not retry a prompt Google blocked", async () => {
    stubFetch(json({ promptFeedback: { blockReason: "SAFETY" } }));
    await expect(gemini().complete(request)).rejects.toMatchObject({
      message: expect.stringContaining("SAFETY"),
      retryable: false,
    });
  });

  it("does not retry a candidate cut off for safety", async () => {
    stubFetch(json({ candidates: [{ finishReason: "SAFETY" }] }));
    await expect(gemini().complete(request)).rejects.toMatchObject({ retryable: false });
  });

  it("retries an empty candidate for a non-safety reason", async () => {
    stubFetch(json({ candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }] }));
    await expect(gemini().complete(request)).rejects.toMatchObject({
      message: expect.stringContaining("MAX_TOKENS"),
      retryable: true,
    });
  });

  it("treats a timeout as retryable", async () => {
    stubFetch(timeout());
    await expect(gemini().complete(request)).rejects.toMatchObject({
      message: expect.stringContaining("timed out after 1000ms"),
      retryable: true,
    });
  });
});

describe("toGeminiSchema", () => {
  it("uppercases types, maps a null union to nullable, and keeps constraints", () => {
    expect(toGeminiSchema(request.schema)).toEqual({
      type: "OBJECT",
      properties: {
        reason: { type: "STRING" },
        score: { type: "INTEGER", minimum: 1, maximum: 10 },
        deadline: { type: "STRING", nullable: true },
      },
      propertyOrdering: ["reason", "score", "deadline"],
      required: ["reason", "score", "deadline"],
    });
  });

  it("passes enums through", () => {
    expect(toGeminiSchema({ type: "string", enum: ["a", "b"] })).toEqual({ type: "STRING", enum: ["a", "b"] });
  });
});

/* ---------------------------------------------------------------------------
 * Ollama
 * ------------------------------------------------------------------------- */

describe("ollama provider", () => {
  const ollama = (baseUrl = "http://localhost:11434") =>
    createOllamaProvider({ baseUrl, model: "llama3.1:8b", timeoutMs: 1000 });

  it("posts to /api/chat, non-streaming, with the JSON Schema as `format`", async () => {
    const mock = stubFetch(json({ message: { role: "assistant", content: MODEL_JSON } }));
    await expect(ollama().complete(request)).resolves.toBe(MODEL_JSON);

    expect(mock.mock.calls[0]![0]).toBe("http://localhost:11434/api/chat");
    expect(sentBody(mock)).toEqual({
      model: "llama3.1:8b",
      stream: false,
      format: request.schema,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user },
      ],
    });
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const mock = stubFetch(json({ message: { content: MODEL_JSON } }));
    await ollama("http://gpu-box:11434/").complete(request);
    expect(mock.mock.calls[0]![0]).toBe("http://gpu-box:11434/api/chat");
  });

  it("says to pull the model when it isn't installed, and does not retry", async () => {
    stubFetch(json({ error: 'model "llama3.1:8b" not found, try pulling it first' }, 404));
    await expect(ollama().complete(request)).rejects.toMatchObject({
      message: expect.stringContaining("ollama pull llama3.1:8b"),
      retryable: false,
      status: 404,
    });
  });

  it("asks whether Ollama is running when the connection is refused, and retries", async () => {
    stubFetch(connectionRefused());
    await expect(ollama().complete(request)).rejects.toMatchObject({
      message: expect.stringMatching(/ECONNREFUSED.*is Ollama running at http:\/\/localhost:11434/),
      retryable: true,
    });
  });

  it("rejects an empty message", async () => {
    stubFetch(json({ message: { content: "" } }));
    await expect(ollama().complete(request)).rejects.toMatchObject({ name: "ProviderError" });
  });
});

/* ---------------------------------------------------------------------------
 * createProvider — env-driven selection
 * ------------------------------------------------------------------------- */

describe("createProvider", () => {
  const base = {
    LLM_TIMEOUT_MS: 1000,
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: "gemini-3.5-flash",
    OLLAMA_BASE_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama3.1:8b",
  };

  it("builds Gemini when LLM_PROVIDER=gemini", () => {
    const provider = createProvider({ ...base, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(provider).toMatchObject({ name: "gemini", model: "gemini-3.5-flash" });
  });

  it("builds Ollama when LLM_PROVIDER=ollama, without requiring a Gemini key", () => {
    const provider = createProvider({ ...base, LLM_PROVIDER: "ollama" });
    expect(provider).toMatchObject({ name: "ollama", model: "llama3.1:8b" });
  });

  it("names the missing variable when Gemini has no key", () => {
    expect(() => createProvider({ ...base, LLM_PROVIDER: "gemini" })).toThrow(/GEMINI_API_KEY/);
  });

  it("makes no network call at construction time", () => {
    const mock = stubFetch();
    createProvider({ ...base, LLM_PROVIDER: "ollama" });
    expect(mock).not.toHaveBeenCalled();
  });
});

/* ---------------------------------------------------------------------------
 * Retry delays — so a 429 on a 5-per-minute quota waits the right amount
 * ------------------------------------------------------------------------- */

describe("retry delay", () => {
  const gemini = () => createGeminiProvider({ apiKey: "k", model: "gemini-3.5-flash", timeoutMs: 1000 });

  /** Shape of Gemini's free-tier quota error, trimmed. */
  const quotaError = (retryDelay: string) =>
    json(
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "x".repeat(600), // longer than the truncated message, as in reality
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
          ],
        },
      },
      429,
    );

  it("reads Gemini's RetryInfo, even when it sits past the truncated message", async () => {
    stubFetch(quotaError("32.851340449s"));
    await expect(gemini().complete(request)).rejects.toMatchObject({
      status: 429,
      retryable: true,
      retryAfterMs: 32_852,
    });
  });

  it("prefers a Retry-After header when present", async () => {
    stubFetch(
      new Response("{}", { status: 503, headers: { "retry-after": "7" } }),
    );
    await expect(gemini().complete(request)).rejects.toMatchObject({ status: 503, retryAfterMs: 7000 });
  });

  it("leaves retryAfterMs unset when the backend gives no hint", async () => {
    stubFetch(json({ error: { message: "high demand" } }, 503));
    const err = await gemini().complete(request).catch((e: unknown) => e);
    expect(err).toMatchObject({ retryable: true });
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });

  it.each(["", "not json", '{"error":{"details":[{"retryDelay":"soon"}]}}'])(
    "ignores an unparseable body: %j",
    (body) => {
      expect(parseRetryDelay(body)).toBeUndefined();
    },
  );
});
