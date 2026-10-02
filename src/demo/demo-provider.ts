import { ProviderError, type LlmProvider } from "../scoring/provider.js";
import type { DemoEmail } from "./emails.js";

/**
 * An offline stand-in for the LLM so `npm run demo` needs no API key.
 *
 * It finds which demo email a request is about by its sender address (each
 * demo sender is unique) and plays that email's scripted replies in order.
 * Everything around it is real: the rule filter, the prompt, Zod validation
 * and re-prompt, BullMQ retries, Postgres writes.
 */
export function createDemoProvider(emails: readonly DemoEmail[]): LlmProvider {
  const calls = new Map<string, number>();

  return {
    name: "ollama",
    model: "demo-canned-replies",
    async complete(request) {
      const match = emails.find((d) => d.reply && request.user.includes(d.email.senderEmail));
      if (!match?.reply) throw new ProviderError("demo provider: no scripted reply for this email", "ollama", false);

      const n = calls.get(match.email.gmailId) ?? 0;
      calls.set(match.email.gmailId, n + 1);
      const reply = match.reply[Math.min(n, match.reply.length - 1)]!;

      // A little latency so the table's latency column isn't all zeros.
      await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 250));

      if (reply === "http-503") {
        throw new ProviderError("ollama returned HTTP 503: model overloaded (demo)", "ollama", true, 503);
      }
      if (reply === "invalid-json") return "Sure! Here's my assessment: score 8, it's academic.";
      return reply;
    },
  };
}
