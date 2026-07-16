-- k-sampling batches for rubric steering. Each batch is k judge runs against
-- one document, aggregated to per-criterion pass rates with confidence
-- intervals. The editor compares batches to see whether a change moved a rate
-- beyond the ~40% run-to-run noise.

CREATE TABLE IF NOT EXISTS "rubric_draft_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "draft_id" uuid NOT NULL REFERENCES "rubric_drafts"("id") ON DELETE CASCADE,
  "document_ref" varchar(128) NOT NULL,
  "k" integer NOT NULL,
  "stats" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rubric_draft_batches_draft_idx" ON "rubric_draft_batches" ("draft_id");