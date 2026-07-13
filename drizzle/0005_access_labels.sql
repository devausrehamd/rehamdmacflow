-- Enforcement labels on the table registry. A table's visibility is a registry
-- fact: the data API refuses a table_id whose labels do not intersect the
-- caller's. Default '[]' means invisible - fail closed for existing rows until
-- a reindex writes real labels.

ALTER TABLE "table_registry"
  ADD COLUMN IF NOT EXISTS "access_labels" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "live_source_registry"
  ADD COLUMN IF NOT EXISTS "access_labels" jsonb NOT NULL DEFAULT '[]'::jsonb;