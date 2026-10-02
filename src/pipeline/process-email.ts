import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { emails, type NewEmail } from "../db/schema.js";
import type { TriageEmail } from "../core/types.js";
import type { Logger } from "../lib/logger.js";
import { applyRules, type RuleName } from "../rules/filter.js";
import { scoreEmail } from "../scoring/scorer.js";
import type { LlmProvider } from "../scoring/provider.js";
import { getSenderHistory, loadCriteria } from "./queries.js";

export interface PipelineDeps {
  db: Database;
  provider: LlmProvider;
  log: Logger;
}

export type ProcessOutcome =
  /** Already processed by an earlier job (or a concurrent one); nothing written. */
  | { status: "duplicate"; emailId: number }
  | { status: "filtered"; emailId: number; rule: RuleName }
  | { status: "scored"; emailId: number; score: number; category: string; llmLatencyMs: number };

/**
 * filter → score → persist, for one email.
 *
 * Plain async function with injected deps, no BullMQ in sight, so the queue
 * worker is a thin wrapper and the integration tests can call this directly.
 *
 * ## Idempotency
 * Two layers, both keyed on gmail_id:
 * 1. The row is inserted ON CONFLICT DO NOTHING, then read back. If it is
 *    already `processed_at`, this is a replay and we stop before any LLM call.
 * 2. The final write is conditional on `processed_at IS NULL`. If two jobs
 *    for the same email race past step 1, both may score it, but only the
 *    first write lands; the loser reports `duplicate`. So a row is processed
 *    at most once, which is what notifications (phase 6) will key off.
 *
 * A failed attempt leaves an unprocessed row behind; the retry finds it in
 * step 1 and carries on, which is the point of reading back rather than
 * treating every conflict as "done".
 */
export async function processEmail(email: TriageEmail, deps: PipelineDeps): Promise<ProcessOutcome> {
  const { db, provider, log } = deps;

  const row = await upsertEmail(db, email);
  if (row.processedAt !== null) {
    return { status: "duplicate", emailId: row.id };
  }

  const criteria = await loadCriteria(db);
  const decision = applyRules(email, criteria);

  if (decision.filtered) {
    log.info(
      { gmailId: email.gmailId, rule: decision.rule, detail: decision.detail },
      "skipped the LLM",
    );
    const won = await finalize(db, row.id, { filteredByRule: decision.rule });
    return won
      ? { status: "filtered", emailId: row.id, rule: decision.rule }
      : { status: "duplicate", emailId: row.id };
  }

  if (decision.exemptedBy) {
    log.debug({ gmailId: email.gmailId, exemptedBy: decision.exemptedBy, detail: decision.detail }, "rule exemption");
  }

  const history = await getSenderHistory(db, email.senderEmail, email.receivedAt);
  const result = await scoreEmail(email, criteria, provider, history);

  const won = await finalize(db, row.id, {
    category: result.category,
    score: result.score,
    reason: result.reason,
    isTimeSensitive: result.isTimeSensitive,
    deadline: result.deadline,
    llmLatencyMs: result.llmLatencyMs,
  });
  if (!won) return { status: "duplicate", emailId: row.id };

  log.info(
    {
      gmailId: email.gmailId,
      score: result.score,
      category: result.category,
      llmLatencyMs: result.llmLatencyMs,
      historySize: history.length,
      provider: result.provider,
      model: result.model,
    },
    "scored",
  );
  return {
    status: "scored",
    emailId: row.id,
    score: result.score,
    category: result.category,
    llmLatencyMs: result.llmLatencyMs,
  };
}

async function upsertEmail(db: Database, email: TriageEmail) {
  await db
    .insert(emails)
    .values({
      gmailId: email.gmailId,
      threadId: email.threadId ?? null,
      sender: email.sender,
      senderEmail: email.senderEmail,
      subject: email.subject,
      bodySnippet: email.bodySnippet,
      receivedAt: email.receivedAt,
    })
    .onConflictDoNothing({ target: emails.gmailId });

  const [row] = await db
    .select({ id: emails.id, processedAt: emails.processedAt })
    .from(emails)
    .where(eq(emails.gmailId, email.gmailId));
  // Unreachable unless the row was deleted between the two statements.
  if (!row) throw new Error(`email ${email.gmailId} vanished after insert`);
  return row;
}

/** Write the outcome and mark processed. Returns false if another job got there first. */
async function finalize(db: Database, id: number, fields: Partial<NewEmail>): Promise<boolean> {
  const updated = await db
    .update(emails)
    .set({ ...fields, processedAt: new Date() })
    .where(and(eq(emails.id, id), isNull(emails.processedAt)))
    .returning({ id: emails.id });
  return updated.length > 0;
}
