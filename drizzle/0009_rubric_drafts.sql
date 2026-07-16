-- Rubric drafts: the GUI's staging area for authoring new document types.
-- Committed rubrics stay in rubrics/*.json (git). This table is mutable,
-- per-author, and NEVER loaded by the evaluation pipeline - a draft governs
-- nothing until it is exported to JSON and checked into git by hand.

CREATE TABLE IF NOT EXISTS "rubric_drafts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_type" varchar(64) NOT NULL,
  "author_id" varchar(64) NOT NULL,
  "content" jsonb NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'draft',
  "validation" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubric_drafts_author_idx" ON "rubric_drafts" ("author_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubric_drafts_type_idx" ON "rubric_drafts" ("document_type");