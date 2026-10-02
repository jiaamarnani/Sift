import pino from "pino";
import { env, isProduction } from "../config/env.js";

/**
 * One root logger; every module takes a child with a `component` field.
 *
 * Structured (JSON) in production so a log drain can filter on
 * `component`/`gmailId`/`score`; pretty-printed locally for readability.
 * Child loggers mean a line from the scorer is greppable without adding a
 * prefix to every message by hand.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "sifter" },
  redact: {
    // Never let a token reach a log line, even by accident.
    paths: [
      "req.headers.authorization",
      "req.headers['x-telegram-bot-api-secret-token']",
      "*.accessToken",
      "*.refreshToken",
      "*.apiKey",
    ],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }),
});

export function childLogger(component: string) {
  return logger.child({ component });
}

export type Logger = pino.Logger;
