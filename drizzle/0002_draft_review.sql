-- Draft-and-review pipeline (draft mode)
-- Draft sets (the consistency unit), documents, review rounds, issue items.

CREATE TABLE IF NOT EXISTS "draft_sets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "originating_query_id" text NOT NULL,
  "document_type" varchar(64) NOT NULL,
  "rubric_version" varchar(64) NOT NULL,
  "rubric_hash" varchar(64) NOT NULL,
  "status" varchar(32) DEFAULT 'generating' NOT NULL,
  "disposition" varchar(16),
  "disposition_reason" text,
  "rerun_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_sets_query_idx" ON "draft_sets" ("originating_query_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_sets_status_idx" ON "draft_sets" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_sets_type_idx" ON "draft_sets" ("document_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "draft_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "set_id" uuid NOT NULL REFERENCES "draft_sets"("id") ON DELETE CASCADE,
  "title" varchar(512) NOT NULL,
  "content" text NOT NULL,
  "objective_scores" jsonb,
  "objective_fraction" integer,
  "expert_results" jsonb,
  "trajectory_results" jsonb,
  "annotations" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_documents_set_idx" ON "draft_documents" ("set_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "review_rounds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "set_id" uuid NOT NULL REFERENCES "draft_sets"("id") ON DELETE CASCADE,
  "round_number" integer NOT NULL,
  "rubric_version" varchar(64) NOT NULL,
  "rubric_hash" varchar(64) NOT NULL,
  "decision" varchar(16),
  "decided_by" uuid REFERENCES "users"("id"),
  "decided_at" timestamp with time zone,
  "scores_snapshot" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_rounds_set_idx" ON "review_rounds" ("set_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "issue_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "round_id" uuid NOT NULL REFERENCES "review_rounds"("id") ON DELETE CASCADE,
  "document_id" uuid REFERENCES "draft_documents"("id") ON DELETE CASCADE,
  "section" varchar(255),
  "criterion_id" varchar(64),
  "category" varchar(32) DEFAULT 'other' NOT NULL,
  "detail" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_items_round_idx" ON "issue_items" ("round_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_items_document_idx" ON "issue_items" ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_items_criterion_idx" ON "issue_items" ("criterion_id");