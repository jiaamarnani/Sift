import { postJson, ProviderError, type CompletionRequest, type LlmProvider } from "../provider.js";

interface OllamaChatResponse {
  message?: { content?: string };
}

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/**
 * A local model through Ollama's `/api/chat`.
 *
 * `format` takes a JSON Schema and constrains decoding to it, which is what
 * makes small local models usable here at all: without it an 8B model will
 * happily wrap the JSON in prose or a code fence.
 */
export function createOllamaProvider(config: OllamaConfig): LlmProvider {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/api/chat`;

  return {
    name: "ollama",
    model: config.model,

    async complete(request: CompletionRequest): Promise<string> {
      const body = {
        model: config.model,
        stream: false,
        format: request.schema,
        options: { temperature: 0 },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      };

      let data: OllamaChatResponse;
      try {
        data = (await postJson("ollama", url, body, { timeoutMs: config.timeoutMs })) as OllamaChatResponse;
      } catch (err) {
        throw withHint(err, config);
      }

      const text = data.message?.content ?? "";
      if (text.trim() === "") {
        throw new ProviderError("ollama returned an empty message", "ollama", true);
      }
      return text;
    },
  };
}

/** The two local-setup mistakes everyone makes once, with the fix in the message. */
function withHint(err: unknown, config: OllamaConfig): unknown {
  if (!(err instanceof ProviderError)) return err;
  if (err.status === 404) {
    return new ProviderError(
      `${err.message} — run \`ollama pull ${config.model}\``,
      "ollama",
      false,
      404,
    );
  }
  if (err.status === undefined && /ECONNREFUSED/.test(err.message)) {
    return new ProviderError(
      `${err.message} — is Ollama running at ${config.baseUrl}? (\`ollama serve\`)`,
      "ollama",
      true,
    );
  }
  return err;
}
