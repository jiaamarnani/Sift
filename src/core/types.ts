import type { FeedbackValue, UserCriteria } from "../db/schema.js";

/**
 * The normalized email shape the pipeline passes around.
 *
 * Deliberately *not* the `emails` DB row: the rule filter runs before the row
 * is written, and the Gmail client produces this straight from the API
 * response. Keeping a plain input type means the filter and the scorer can be
 * unit-tested with a literal object, no database and no Gmail fixture.
 */
export interface TriageEmail {
  gmailId: string;
  threadId?: string | null;
  /** Raw `From` header, kept verbatim for display. */
  sender: string;
  /** Lowercased bare address parsed out of `sender`. */
  senderEmail: string;
  subject: string | null;
  /** Plaintext snippet plus truncated body — what the LLM scores. */
  bodySnippet: string | null;
  receivedAt: Date;
  /**
   * Message headers with **lowercased keys**. The newsletter rule reads
   * `list-unsubscribe` / `list-id` / `precedence` from here. Lowercasing at
   * the boundary (in the Gmail client) means no rule has to remember that
   * header names are case-insensitive.
   */
  headers: Readonly<Record<string, string>>;
}

/**
 * Only the criteria fields the rule filter actually reads.
 *
 * A `Pick` rather than the whole `UserCriteria` row so tests can construct
 * three fields instead of thirteen, and so it's obvious at a glance that the
 * filter never touches `threshold` or `enabledChannels` — those belong to the
 * notifier stage.
 */
export type FilterCriteria = Pick<UserCriteria, "blocklist" | "prioritySenders" | "keywords">;

/** Only the criteria fields the scorer puts in front of the LLM. */
export type ScoringCriteria = Pick<
  UserCriteria,
  "prioritySenders" | "keywords" | "highPriorityCategories" | "lowPriorityCategories" | "criteriaPrompt"
>;

/**
 * One earlier email from the same sender, as the scorer sees it.
 *
 * This is what the original design's `get_sender_history()` tool would have
 * returned. The worker fetches it before the call instead, so scoring stays
 * one request per email (see CLAUDE.md).
 */
export interface SenderHistoryEntry {
  receivedAt: Date;
  subject: string | null;
  score: number;
  category: string | null;
  /** The user's 👍/👎 on that email's score, if they gave one. */
  feedback: FeedbackValue | null;
}

/** Case-insensitive header lookup against a `TriageEmail`. */
export function getHeader(email: TriageEmail, name: string): string | undefined {
  return email.headers[name.toLowerCase()];
}
