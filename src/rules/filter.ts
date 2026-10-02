import { matchesSenderPattern, splitAddress } from "../lib/email-address.js";
import { getHeader, type FilterCriteria, type TriageEmail } from "../core/types.js";

/**
 * The rule filter: a pure function that decides whether an email is obvious
 * enough junk to skip the LLM entirely.
 *
 * ## Why it exists
 * Every email that reaches the scorer costs an API call and ~1-2s of latency.
 * Most inbox volume is newsletters and receipts that no reasonable scorer would
 * rate highly, so filtering them in-process is free accuracy and real money.
 *
 * ## What it optimises for
 * **Recall over precision, always.** A newsletter that slips through costs one
 * API call and gets scored 2/10 — invisible. An interview invitation that gets
 * dropped here is never seen by anything downstream: no score, no
 * notification, no digest entry, and nothing in the logs that looks like a
 * failure. The two errors are not remotely symmetric, so every judgement call
 * below is biased toward letting mail through.
 *
 * This is why the heuristics are narrow and header-driven rather than clever,
 * and why the exemptions exist at all.
 *
 * ## Precedence (first match wins)
 * 1. **Blocklist** -> drop. An address the user typed in explicitly outranks
 *    everything, including the keyword exemption.
 * 2. **Priority sender** -> keep. Never filtered, whatever else matches.
 * 3. **Priority keyword** -> keep. The safety net described below.
 * 4. **Heuristics** -> `no_reply_sender`, `newsletter`, `receipt`.
 *
 * Explicit deny beats explicit allow beats keyword allow beats heuristic.
 *
 * ## The exemption that matters most
 * Applicant tracking systems — Greenhouse, Lever, Workday, Ashby — send from
 * `no-reply@` addresses and frequently attach `List-Unsubscribe`. Rules 3 and 4
 * below would therefore drop real interview invitations, which is the single
 * worst thing this service could do. The keyword exemption is what prevents
 * it: an email whose subject or body contains "interview", "co-op", or
 * "deadline" is never dropped by a heuristic, no matter how automated it looks.
 *
 * The cost of that exemption is some marketing mail ("last chance — deadline
 * tonight!") reaching the LLM and being scored 2/10. That is the correct
 * trade: one wasted API call versus a missed interview.
 */

export const RULE_NAMES = ["blocklist", "no_reply_sender", "newsletter", "receipt"] as const;
export type RuleName = (typeof RULE_NAMES)[number];

export type ExemptionReason = "priority_sender" | "priority_keyword";

export type RuleDecision =
  | {
      filtered: true;
      /** Which rule fired. Stored in `emails.filtered_by_rule` and broken out in /metrics. */
      rule: RuleName;
      /** Human-readable cause, for logs and debugging. */
      detail: string;
    }
  | {
      filtered: false;
      /** Set when an exemption overrode a heuristic that would otherwise have fired. */
      exemptedBy?: ExemptionReason;
      detail?: string;
    };

/* ---------------------------------------------------------------------------
 * Heuristic patterns
 * ------------------------------------------------------------------------- */

/**
 * Local parts that indicate an unmonitored mailbox.
 *
 * Anchored and exact-ish on purpose. An earlier draft included
 * `notifications?` and `automated`, which matches `notifications@greenhouse.io`
 * — an address that delivers interview scheduling requests. Dropped it:
 * "looks automated" is not the same as "is not worth reading".
 */
const NO_REPLY_LOCAL_PART =
  /^(no[-._]?reply|do[-._]?not[-._]?reply|reply[-._]?not[-._]?monitored|unmonitored|bounce[sd]?|mailer[-._]?daemon|postmaster|devnull)([-._+].*)?$/;

/**
 * Headers that mark bulk/list mail. RFC 2369 `List-Unsubscribe` and RFC 2919
 * `List-Id` are what mailing-list software sets; `Precedence: bulk|list|junk`
 * is the older convention. Gmail preserves all of them.
 *
 * Header-based rather than scanning the body for the word "unsubscribe":
 * the header is what the *sender* declared about the message, whereas the word
 * appears in plenty of one-to-one mail with a footer template.
 *
 * `Auto-Submitted: auto-generated` is deliberately NOT here — calendar invites
 * carry it, and a calendar invite is very often the interview.
 */
const BULK_PRECEDENCE = /^(bulk|list|junk)$/i;

/**
 * Receipt/order subjects. Subject-only, because body text mentioning an order
 * number over-triggers badly.
 *
 * Note the omission: no bare `invoice` and no `payment received`. For someone
 * doing freelance work those are income, not noise — "Invoice #42 approved"
 * matters. Only unambiguous consumer-purchase phrasing is here.
 */
const RECEIPT_SUBJECT = new RegExp(
  [
    String.raw`\breceipt\b`,
    String.raw`\byour (order|purchase|receipt|subscription)\b`,
    String.raw`\border (confirmation|confirmed|number|#\d+)\b`,
    String.raw`\b(has shipped|out for delivery|has been delivered|tracking number)\b`,
    String.raw`\bpayment (confirmation|successful|processed)\b`,
    String.raw`\bthanks? for your (order|purchase|payment)\b`,
    String.raw`\b(subscription|membership|plan) (renewed|renewal confirmation)\b`,
    String.raw`\byou(r|'ve) been charged\b`,
  ].join("|"),
  "i",
);

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * Decide whether `email` should skip the LLM.
 *
 * Pure: no I/O, no clock, no logging. The caller records the decision (writing
 * `filtered_by_rule` and emitting the "skipped the LLM" log line), which keeps
 * this function trivially unit-testable and keeps the log format out of the
 * business logic.
 */
export function applyRules(email: TriageEmail, criteria: FilterCriteria): RuleDecision {
  const address = email.senderEmail;

  // 1. Explicit blocklist — wins over every exemption below.
  const blocked = firstMatchingPattern(address, criteria.blocklist);
  if (blocked !== null) {
    return { filtered: true, rule: "blocklist", detail: `sender matches blocklist "${blocked}"` };
  }

  // 2. Explicit priority sender — never filtered.
  const priority = firstMatchingPattern(address, criteria.prioritySenders);
  if (priority !== null) {
    return {
      filtered: false,
      exemptedBy: "priority_sender",
      detail: `sender matches priority pattern "${priority}"`,
    };
  }

  // Evaluate the heuristics before applying the keyword exemption, so the log
  // line can say *what* was overridden. Knowing "this Greenhouse mail would
  // have been dropped as no_reply but the keyword 'interview' saved it" is the
  // difference between trusting the filter and guessing at it.
  const heuristic = evaluateHeuristics(email);

  if (heuristic !== null) {
    const keyword = firstMatchingKeyword(email, criteria.keywords);
    if (keyword !== null) {
      return {
        filtered: false,
        exemptedBy: "priority_keyword",
        detail: `would have been dropped by ${heuristic.rule} (${heuristic.detail}) but matched keyword "${keyword}"`,
      };
    }
    return heuristic;
  }

  return { filtered: false };
}

/**
 * Run the heuristic rules in order and return the first that fires.
 * Separate from `applyRules` so the exemption logic above can inspect the
 * result before deciding.
 */
function evaluateHeuristics(email: TriageEmail): Extract<RuleDecision, { filtered: true }> | null {
  const { localPart } = splitAddress(email.senderEmail);
  if (localPart !== "" && NO_REPLY_LOCAL_PART.test(localPart)) {
    return {
      filtered: true,
      rule: "no_reply_sender",
      detail: `sender local part "${localPart}" is an unmonitored mailbox`,
    };
  }

  const newsletterHeader = detectBulkHeader(email);
  if (newsletterHeader !== null) {
    return { filtered: true, rule: "newsletter", detail: newsletterHeader };
  }

  const subject = email.subject ?? "";
  if (RECEIPT_SUBJECT.test(subject)) {
    return { filtered: true, rule: "receipt", detail: `subject matches receipt pattern` };
  }

  return null;
}

function detectBulkHeader(email: TriageEmail): string | null {
  if (getHeader(email, "list-unsubscribe")) return "has List-Unsubscribe header";
  if (getHeader(email, "list-id")) return "has List-Id header";

  const precedence = getHeader(email, "precedence");
  if (precedence && BULK_PRECEDENCE.test(precedence.trim())) {
    return `Precedence: ${precedence.trim()}`;
  }
  return null;
}

/** Return the first pattern in `patterns` matching `address`, or null. */
function firstMatchingPattern(address: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (matchesSenderPattern(address, pattern)) return pattern;
  }
  return null;
}

/**
 * Return the first keyword found in the subject or body snippet, or null.
 *
 * Matches on both fields rather than subject alone: "Following up on your
 * co-op application" can easily carry a generic subject like "Quick question".
 * Broader matching means more exemptions, and more exemptions means more LLM
 * calls — which is the cheap direction to be wrong in.
 */
function firstMatchingKeyword(email: TriageEmail, keywords: readonly string[]): string | null {
  const haystack = `${email.subject ?? ""}\n${email.bodySnippet ?? ""}`;
  if (haystack.trim() === "") return null;

  for (const keyword of keywords) {
    const trimmed = keyword.trim();
    if (trimmed === "") continue;
    if (keywordRegex(trimmed).test(haystack)) return keyword;
  }
  return null;
}

/**
 * Build a word-boundary regex for a configured keyword.
 *
 * Word boundaries so "coop" doesn't match "cooperation" and "offer" doesn't
 * match "offered a newsletter". Cached because this runs per keyword per email
 * and the keyword list is stable for the life of the process.
 */
const keywordRegexCache = new Map<string, RegExp>();

function keywordRegex(keyword: string): RegExp {
  const cached = keywordRegexCache.get(keyword);
  if (cached) return cached;

  // \b is useless next to a non-word character, so only anchor the ends that
  // begin/end with a word character. Without this, a keyword like "c++" or a
  // leading-punctuation term would never match.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^\w/.test(keyword) ? String.raw`\b` : "";
  const right = /\w$/.test(keyword) ? String.raw`\b` : "";
  const regex = new RegExp(`${left}${escaped}${right}`, "i");

  keywordRegexCache.set(keyword, regex);
  return regex;
}
