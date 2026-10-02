import "dotenv/config";
import { z } from "zod";

/**
 * Validate the environment once, at boot, and export a typed object.
 *
 * Why: an unset TELEGRAM_BOT_TOKEN should crash the process on startup with a
 * readable message, not produce a 401 from Telegram three hours into a poll
 * cycle. Everything downstream imports `env` and gets real types instead of
 * `string | undefined`.
 *
 * Integration credentials are optional so phases 1-4 boot without Gmail,
 * LLM, or Telegram keys. The modules that need them assert at use time
 * via `requireEnv()`.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // Required from phase 1 on.
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // Phase 3: scoring. LLM_PROVIDER picks the backend; only the selected
  // provider's settings are asserted, at use time, by createProvider().
  LLM_PROVIDER: z.enum(["gemini", "ollama"]).default("gemini"),
  // Client-side cap on outbound scoring calls. Gemini's free tier allows
  // 5 requests/min and 20/day per model (seen in 429 bodies), so the default
  // sits there. Raise it for Ollama or a paid key.
  LLM_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  // Generous because a local Ollama model on a laptop can take 20s+ cold.
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().default("gemini-3.5-flash"),
  OLLAMA_BASE_URL: z.string().url().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.1:8b"),

  // Phase 5.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().url().default("http://localhost:3000/oauth/gmail/callback"),
  GOOGLE_REFRESH_TOKEN: z.string().optional(),
  GMAIL_USER_EMAIL: z.string().email().optional(),

  // Phase 6.
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().min(16).optional(),

  POLL_CRON: z.string().default("*/15 * * * *"),
  TIMEZONE: z.string().default("America/New_York"),
});

/**
 * Treat an empty value as absent.
 *
 * `.env.example` ships keys with no value (`TELEGRAM_BOT_TOKEN=`) so you can
 * see what needs filling in. dotenv reads those as `""`, which Zod sees as
 * present-but-invalid — `.optional()` admits `undefined`, not `""`, and a
 * `.min(16)` would reject it. Stripping empties here means an unfilled key
 * behaves exactly like an unset one: optionals stay undefined and defaults
 * apply. Done once at the boundary rather than with `.or(z.literal(""))` on
 * every field.
 */
const rawEnv = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ""),
);

const parsed = schema.safeParse(rawEnv);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // Not using the logger here: the logger itself reads env.
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

/**
 * Assert that an optional credential is present, with a message naming the
 * variable. Used by integration modules at their entry point.
 */
export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const value = env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${String(key)} (see .env.example)`);
  }
  return value as NonNullable<Env[K]>;
}

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
