import { and, desc, eq, isNotNull, lt } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { emails, feedback, userCriteria, type UserCriteria } from "../db/schema.js";
import type { SenderHistoryEntry } from "../core/types.js";

/** How many earlier emails from a sender the scorer sees. */
export const SENDER_HISTORY_LIMIT = 5;

/**
 * The user_criteria row is missing, so nothing can be filtered or scored.
 * Not retryable: it won't appear by waiting; someone has to run `db:seed`.
 */
export class MissingCriteriaError extends Error {
  override readonly name = "MissingCriteriaError";
  readonly retryable = false;

  constructor() {
    super("user_criteria has no row; run `npm run db:seed`");
  }
}

/**
 * Load the single criteria row.
 *
 * Read per job rather than cached at worker start: criteria are meant to be
 * tuned at runtime (see schema.ts), and a primary-key read is cheap next to
 * an LLM call.
 */
export async function loadCriteria(db: Database): Promise<UserCriteria> {
  const [row] = await db.select().from(userCriteria).limit(1);
  if (!row) throw new MissingCriteriaError();
  return row;
}

/**
 * The sender's most recent scored emails received *before* `before`, newest
 * first, with any feedback.
 *
 * Bounded by `receivedAt` rather than "everything except this row" so that
 * re-scoring an old email (a retry, a backfill, the eval harness) sees only
 * what was known when it arrived, not mail that came later. Filtered mail is
 * left out: it has no score, so it says nothing about how this sender rates.
 */
export async function getSenderHistory(
  db: Database,
  senderEmail: string,
  before: Date,
  limit = SENDER_HISTORY_LIMIT,
): Promise<SenderHistoryEntry[]> {
  if (senderEmail === "") return [];

  const rows = await db
    .select({
      receivedAt: emails.receivedAt,
      subject: emails.subject,
      score: emails.score,
      category: emails.category,
      feedback: feedback.value,
    })
    .from(emails)
    .leftJoin(feedback, eq(feedback.emailId, emails.id))
    .where(
      and(eq(emails.senderEmail, senderEmail), lt(emails.receivedAt, before), isNotNull(emails.score)),
    )
    .orderBy(desc(emails.receivedAt))
    .limit(limit);

  // The WHERE clause guarantees score is set; this just narrows the type.
  return rows.flatMap((r) => (r.score === null ? [] : [{ ...r, score: r.score }]));
}
