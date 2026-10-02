import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/* ---------------------------------------------------------------------------
 * Enums
 *
 * Postgres enums rather than free-text columns: the database rejects a typo
 * like 'thumbs_up' instead of quietly storing it and breaking the precision
 * metric weeks later. Drizzle also derives TS union types from these.
 * ------------------------------------------------------------------------- */

export const feedbackValueEnum = pgEnum("feedback_value", ["up", "down"]);
export const feedbackSourceEnum = pgEnum("feedback_source", ["telegram", "api"]);
export const notificationChannelEnum = pgEnum("notification_channel", ["telegram", "digest"]);
export const notificationStatusEnum = pgEnum("notification_status", ["sent", "failed"]);

/* ---------------------------------------------------------------------------
 * emails — one row per Gmail message we have seen
 * ------------------------------------------------------------------------- */

export const emails = pgTable(
  "emails",
  {
    id: serial("id").primaryKey(),

    /**
     * Gmail's immutable message id. UNIQUE, and that constraint *is* the
     * idempotency mechanism: the poller inserts with ON CONFLICT DO NOTHING,
     * so a message seen twice (overlapping poll windows, a queue retry, a
     * replayed job) can never be scored or notified twice. Enforcing this in
     * the database rather than in application code means it holds even if two
     * workers race.
     */
    gmailId: text("gmail_id").notNull(),
    threadId: text("thread_id"),

    /** Raw `From` header, e.g. `Jane Doe <jane@corp.com>` — kept for display. */
    sender: text("sender").notNull(),
    /**
     * Normalised lowercase address extracted from `sender`. Separate column
     * because get_sender_history(email) and the priority-sender rule both need
     * to match on the address alone, and doing that with LIKE against the raw
     * header would be both slow and wrong.
     */
    senderEmail: text("sender_email").notNull(),

    subject: text("subject"),
    /** Gmail's plaintext snippet plus a truncated body — this is what the LLM scores. */
    bodySnippet: text("body_snippet"),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),

    /**
     * Name of the rule that dropped this email before the LLM (e.g.
     * "no_reply_sender"), or NULL if it passed the filter and was scored.
     * Storing the rule *name* rather than a boolean gives the /metrics
     * endpoint a free breakdown of which rules are doing the work.
     */
    filteredByRule: text("filtered_by_rule"),

    // --- Scoring output (NULL until the scoring worker finishes) ---
    category: text("category"),
    score: integer("score"),
    reason: text("reason"),
    isTimeSensitive: boolean("is_time_sensitive"),
    deadline: timestamp("deadline", { withTimezone: true }),

    /** Latency of the LLM call in ms — feeds the avg-LLM-latency metric. */
    llmLatencyMs: integer("llm_latency_ms"),

    notified: boolean("notified").notNull().default(false),
    /** Set when the pipeline finishes, whether by rule-filter or by scoring. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("emails_gmail_id_unique").on(t.gmailId),
    // get_sender_history() filters by sender and orders by recency.
    index("emails_sender_email_idx").on(t.senderEmail, t.receivedAt),
    // The digest query is "score >= threshold in the last 24h".
    index("emails_received_at_score_idx").on(t.receivedAt, t.score),
  ],
);

/* ---------------------------------------------------------------------------
 * feedback — 👍 / 👎 from Telegram buttons or the test endpoint
 * ------------------------------------------------------------------------- */

export const feedback = pgTable(
  "feedback",
  {
    id: serial("id").primaryKey(),
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    value: feedbackValueEnum("value").notNull(),
    source: feedbackSourceEnum("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /**
     * One verdict per email. Telegram will happily deliver the same callback
     * query twice on a network retry, and a user can tap 👍 then 👎; both
     * should end at a single current answer rather than skewing precision.
     * The webhook upserts on this constraint.
     */
    uniqueIndex("feedback_email_id_unique").on(t.emailId),
    index("feedback_created_at_idx").on(t.createdAt),
  ],
);

/* ---------------------------------------------------------------------------
 * notifications — an audit row per delivery attempt, per channel
 * ------------------------------------------------------------------------- */

export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    emailId: integer("email_id")
      .notNull()
      .references(() => emails.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull(),
    status: notificationStatusEnum("status").notNull(),
    /** Populated on status = 'failed' so failures are debuggable after the fact. */
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "notifications sent per channel" in /metrics.
    index("notifications_channel_sent_at_idx").on(t.channel, t.sentAt),
    index("notifications_email_id_idx").on(t.emailId),
  ],
);

/* ---------------------------------------------------------------------------
 * user_criteria — single-row config table
 *
 * A table rather than a config file so criteria can be tuned at runtime (and
 * later from Telegram) without a redeploy, and so Claude's get_user_criteria()
 * tool has one authoritative source. `singleton` is a CHECK-constrained column
 * that guarantees exactly one row can exist.
 * ------------------------------------------------------------------------- */

export const userCriteria = pgTable("user_criteria", {
  id: serial("id").primaryKey(),
  /** Always 1. A unique index on this makes a second config row impossible. */
  singleton: integer("singleton").notNull().default(1),

  /** Addresses or domains that are always important, e.g. ["@northeastern.edu"]. */
  prioritySenders: jsonb("priority_senders").$type<string[]>().notNull().default([]),
  /** Substrings that raise importance, e.g. ["interview", "co-op", "deadline"]. */
  keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
  /** Category names the LLM should score high / low. */
  highPriorityCategories: jsonb("high_priority_categories").$type<string[]>().notNull().default([]),
  lowPriorityCategories: jsonb("low_priority_categories").$type<string[]>().notNull().default([]),
  /** Senders always dropped by the rule filter, before any LLM call. */
  blocklist: jsonb("blocklist").$type<string[]>().notNull().default([]),

  /** Free-text prose handed to Claude verbatim, for nuance the lists can't hold. */
  criteriaPrompt: text("criteria_prompt").notNull().default(""),

  /** Notify at or above this score (1-10). */
  threshold: integer("threshold").notNull().default(7),
  /** Which Notifier implementations are live, e.g. ["telegram", "digest"]. */
  enabledChannels: jsonb("enabled_channels").$type<string[]>().notNull().default(["telegram"]),
  /** Local send time for the daily digest, "HH:MM" in `timezone`. */
  digestTime: text("digest_time").notNull().default("08:00"),
  timezone: text("timezone").notNull().default("America/New_York"),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("user_criteria_singleton_unique").on(t.singleton)]);

/* ---------------------------------------------------------------------------
 * job_failures — dead-letter record
 *
 * BullMQ keeps failed jobs in Redis, but Redis is not the system of record and
 * gets trimmed. This table is the durable dead-letter log the /metrics failure
 * rate reads from, and what you query to find out why an email never arrived.
 * ------------------------------------------------------------------------- */

export const jobFailures = pgTable(
  "job_failures",
  {
    id: serial("id").primaryKey(),
    /** Nullable: a poller failure has no single email attached. */
    emailId: integer("email_id").references(() => emails.id, { onDelete: "set null" }),
    /** Kept independently of emailId so we can log a failure even if no row exists. */
    gmailId: text("gmail_id"),
    /** Which queue the job came from, e.g. "score-email". */
    queue: text("queue").notNull(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull().default(1),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_failures_queue_last_attempt_idx").on(t.queue, t.lastAttemptAt)],
);

/* --------------------------------------------------------------------------
 * Inferred row types — used everywhere instead of hand-written interfaces.
 * ------------------------------------------------------------------------ */

export type Email = typeof emails.$inferSelect;
export type NewEmail = typeof emails.$inferInsert;
export type Feedback = typeof feedback.$inferSelect;
export type NewFeedback = typeof feedback.$inferInsert;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type UserCriteria = typeof userCriteria.$inferSelect;
export type JobFailure = typeof jobFailures.$inferSelect;
export type NewJobFailure = typeof jobFailures.$inferInsert;

export type NotificationChannel = (typeof notificationChannelEnum.enumValues)[number];
export type FeedbackValue = (typeof feedbackValueEnum.enumValues)[number];
export type FeedbackSource = (typeof feedbackSourceEnum.enumValues)[number];
