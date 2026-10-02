import { closeDb, db } from "./client.js";
import { userCriteria } from "./schema.js";
import { env } from "../config/env.js";
import { childLogger } from "../lib/logger.js";

const log = childLogger("seed");

/**
 * Seed the single user_criteria row.
 *
 * Idempotent via ON CONFLICT on the `singleton` unique index, so it can run on
 * every deploy. `onConflictDoNothing` (not update) on purpose: once you've
 * tuned your threshold at runtime, a redeploy must not stomp it back to the
 * default.
 */
export const DEFAULT_CRITERIA: typeof userCriteria.$inferInsert = {
  singleton: 1,

  prioritySenders: [
    // Anything from the university, incl. professors and career services.
    "@northeastern.edu",
    "careers@",
    "recruiting@",
    "talent@",
  ],

  /**
   * Keywords that exempt an email from the heuristic rules (see
   * src/rules/filter.ts). Matching is case-insensitive and word-bounded, so
   * each surface form needs its own entry — "recruiter" does not match
   * "recruiting". Verbose, but it keeps "coop" from matching "cooperation".
   *
   * Over-inclusion is cheap here: a false exemption costs one LLM call and the
   * email scores low. Under-inclusion means a dropped email nobody ever sees.
   */
  keywords: [
    // Interviews and process steps
    "interview",
    "onsite",
    "take-home",
    "final round",
    "phone screen",
    "screening call",
    // Recruiting. Needed because ATS and LinkedIn notifications arrive from
    // no-reply@ addresses, which the no_reply_sender heuristic would drop.
    "recruiter",
    "recruiters",
    "recruiting",
    "recruitment",
    "hiring",
    "hiring manager",
    "your application",
    "your resume",
    "job opportunity",
    // Co-op / internship
    "co-op",
    "coop",
    "internship",
    "offer",
    "reference check",
    // Deadlines
    "deadline",
    "due by",
    // Freelance and brand work
    "partnership",
    "collaboration",
    "sponsorship",
    "contract",
    "invoice due",
  ],

  highPriorityCategories: [
    "brand_partnership",
    "recruiting",
    "academic",
    "freelance_client",
    "deadline",
    "interview_request",
  ],

  lowPriorityCategories: ["marketing", "social_notification", "receipt", "newsletter", "other"],

  /**
   * Senders dropped by the rule filter before any LLM call.
   *
   * Only single-purpose newsletter senders belong here. A blocklist entry
   * outranks the keyword exemption (see src/rules/filter.ts), so anything
   * listed is permanently invisible to the scorer — no score, no
   * notification, no digest entry, and no log line that looks like a failure.
   *
   * Deliberately NOT listed, despite being high-volume:
   *   no-reply@linkedin.com — sends recruiter InMail notifications from the
   *     same address as "you have 7 new profile views", so no sender-level
   *     rule can separate them. Let Claude score it; social noise reliably
   *     lands at 1-3 and never crosses the threshold.
   *   @mailchimp.com — small freelance clients send through Mailchimp.
   */
  blocklist: ["noreply@medium.com", "info@meetup.com", "@substack.com"],

  /**
   * Prose handed to Claude verbatim. The lists above are for exact matching;
   * this is for the nuance they can't express — e.g. that a recruiter email is
   * only high-priority if it names a real role.
   */
  criteriaPrompt: [
    "The user is a computer science student at Northeastern University looking for",
    "software engineering co-ops and internships, who also does freelance work and",
    "occasional brand partnerships.",
    "",
    "Score 8-10: a named interview or onsite invitation; a recruiter or hiring manager",
    "about a specific SWE role; a professor or academic advisor about coursework,",
    "research, or a reference; a paying freelance client; a concrete brand partnership",
    "offer with a stated budget; anything with a hard deadline inside 7 days.",
    "",
    "Score 5-7: a plausible but generic recruiter outreach with no named role; a",
    "university announcement that requires an action but has no near deadline; a",
    "partnership inquiry with no budget or terms yet.",
    "",
    "Score 1-4: marketing and promotional email, newsletters, social network",
    "notifications, receipts and order confirmations, automated digests, job-board",
    "blasts that are not addressed to the user personally.",
    "",
    "Treat urgency and specificity as the strongest signals. A vague 'exciting",
    "opportunity' with no role, company, or deadline is low priority no matter how",
    "enthusiastic it sounds.",
  ].join("\n"),

  threshold: 7,
  enabledChannels: ["telegram", "digest"],
  digestTime: "08:00",
  timezone: env.TIMEZONE,
};

/**
 * Insert the criteria row if absent.
 *
 * @param force  Overwrite an existing row with the defaults above. Off by
 *   default, and deliberately opt-in: once you've tuned your threshold at
 *   runtime, a redeploy running `db:seed` must not silently reset it. Pass
 *   `--force` (`npm run db:seed -- --force`) when you've edited the defaults
 *   in this file and want them pushed to an already-seeded database.
 */
export async function seed(force = false) {
  if (!force) {
    const inserted = await db
      .insert(userCriteria)
      .values(DEFAULT_CRITERIA)
      .onConflictDoNothing({ target: userCriteria.singleton })
      .returning({ id: userCriteria.id });

    if (inserted.length > 0) {
      log.info({ id: inserted[0]?.id }, "seeded user_criteria");
    } else {
      log.info("user_criteria already present, left unchanged (use --force to overwrite)");
    }
    return;
  }

  const [row] = await db
    .insert(userCriteria)
    .values(DEFAULT_CRITERIA)
    .onConflictDoUpdate({
      target: userCriteria.singleton,
      set: { ...DEFAULT_CRITERIA, updatedAt: new Date() },
    })
    .returning({ id: userCriteria.id });

  log.warn({ id: row?.id }, "overwrote user_criteria with seed defaults (--force)");
}

// Only run when invoked directly, so tests can import DEFAULT_CRITERIA.
if (process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js")) {
  seed(process.argv.includes("--force"))
    .then(() => closeDb())
    .catch(async (err) => {
      log.error({ err }, "seed failed");
      await closeDb().catch(() => {});
      process.exit(1);
    });
}
