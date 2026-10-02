import { env, type Env } from "../../config/env.js";
import type { LlmProvider } from "../provider.js";
import { createGeminiProvider } from "./gemini.js";
import { createOllamaProvider } from "./ollama.js";

type ProviderEnv = Pick<
  Env,
  "LLM_PROVIDER" | "LLM_TIMEOUT_MS" | "GEMINI_API_KEY" | "GEMINI_MODEL" | "OLLAMA_BASE_URL" | "OLLAMA_MODEL"
>;

/**
 * Build the provider named by `LLM_PROVIDER`.
 *
 * Only the selected provider's settings are checked, so running on Ollama
 * doesn't demand a Gemini key. Takes the config as a parameter (defaulting to
 * the real env) so tests can exercise both branches without touching
 * `process.env`.
 */
export function createProvider(config: ProviderEnv = env): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case "gemini": {
      if (!config.GEMINI_API_KEY) {
        throw new Error(
          "Missing required environment variable GEMINI_API_KEY (LLM_PROVIDER=gemini; see .env.example)",
        );
      }
      return createGeminiProvider({
        apiKey: config.GEMINI_API_KEY,
        model: config.GEMINI_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
      });
    }
    case "ollama":
      return createOllamaProvider({
        baseUrl: config.OLLAMA_BASE_URL,
        model: config.OLLAMA_MODEL,
        timeoutMs: config.LLM_TIMEOUT_MS,
      });
    default: {
      const unreachable: never = config.LLM_PROVIDER;
      throw new Error(`Unknown LLM_PROVIDER: ${String(unreachable)}`);
    }
  }
}
