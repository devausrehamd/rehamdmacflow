-- Persist the validated section as TYPED ROWS, not text.
--
-- The canonical draft artifact is the ValidatedRow[] the validator produced -
-- values, gaps, recomputed computed fields. Markdown/docx/xlsx are faithful
-- projections of this; none is the source of truth. Storing markdown here
-- would force a lossy serialise and break the render-from-validated-rows
-- contract.

ALTER TABLE "draft_documents" ADD COLUMN IF NOT EXISTS "section_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "draft_documents" ADD COLUMN IF NOT EXISTS "rows" jsonb;
--> statement-breakpoint
ALTER TABLE "draft_documents" ADD COLUMN IF NOT EXISTS "correlation_id" varchar(64);
--> statement-breakpoint
ALTER TABLE "draft_documents" ADD COLUMN IF NOT EXISTS "criterion_results" jsonb;
--> statement-breakpoint

-- content becomes nullable (it is now a derived markdown cache, not required).
ALTER TABLE "draft_documents" ALTER COLUMN "content" DROP NOT NULL;
--> statement-breakpoint

-- Retire the pre-unification columns. Safe: nothing populated them.
ALTER TABLE "draft_documents" DROP COLUMN IF EXISTS "objective_scores";
--> statement-breakpoint
ALTER TABLE "draft_documents" DROP COLUMN IF EXISTS "objective_fraction";
--> statement-breakpoint
ALTER TABLE "draft_documents" DROP COLUMN IF EXISTS "expert_results";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "draft_documents_correlation_idx" ON "draft_documents" ("correlation_id");