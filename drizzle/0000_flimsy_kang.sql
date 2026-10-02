CREATE TYPE "public"."feedback_source" AS ENUM('telegram', 'api');--> statement-breakpoint
CREATE TYPE "public"."feedback_value" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('telegram', 'digest');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TABLE "emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"gmail_id" text NOT NULL,
	"thread_id" text,
	"sender" text NOT NULL,
	"sender_email" text NOT NULL,
	"subject" text,
	"body_snippet" text,
	"received_at" timestamp with time zone NOT NULL,
	"filtered_by_rule" text,
	"category" text,
	"score" integer,
	"reason" text,
	"is_time_sensitive" boolean,
	"deadline" timestamp with time zone,
	"llm_latency_ms" integer,
	"notified" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_id" integer NOT NULL,
	"value" "feedback_value" NOT NULL,
	"source" "feedback_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_failures" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_id" integer,
	"gmail_id" text,
	"queue" text NOT NULL,
	"error" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_id" integer NOT NULL,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_status" NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_criteria" (
	"id" serial PRIMARY KEY NOT NULL,
	"singleton" integer DEFAULT 1 NOT NULL,
	"priority_senders" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"high_priority_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"low_priority_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"criteria_prompt" text DEFAULT '' NOT NULL,
	"threshold" integer DEFAULT 7 NOT NULL,
	"enabled_channels" jsonb DEFAULT '["telegram"]'::jsonb NOT NULL,
	"digest_time" text DEFAULT '08:00' NOT NULL,
	"timezone" text DEFAULT 'America/New_York' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_failures" ADD CONSTRAINT "job_failures_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "emails_gmail_id_unique" ON "emails" USING btree ("gmail_id");--> statement-breakpoint
CREATE INDEX "emails_sender_email_idx" ON "emails" USING btree ("sender_email","received_at");--> statement-breakpoint
CREATE INDEX "emails_received_at_score_idx" ON "emails" USING btree ("received_at","score");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_email_id_unique" ON "feedback" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "feedback_created_at_idx" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "job_failures_queue_last_attempt_idx" ON "job_failures" USING btree ("queue","last_attempt_at");--> statement-breakpoint
CREATE INDEX "notifications_channel_sent_at_idx" ON "notifications" USING btree ("channel","sent_at");--> statement-breakpoint
CREATE INDEX "notifications_email_id_idx" ON "notifications" USING btree ("email_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_criteria_singleton_unique" ON "user_criteria" USING btree ("singleton");