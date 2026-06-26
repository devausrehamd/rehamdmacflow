-- Add the table_registry for the structured-data path.
-- Maps extracted tables to their UUID-named physical SQL tables.

CREATE TABLE IF NOT EXISTS "table_registry" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "source_path" TEXT NOT NULL,
    "source_sha256" VARCHAR(64) NOT NULL,
    "sheet_name" VARCHAR(255),
    "table_index" INTEGER NOT NULL DEFAULT 0,
    "display_name" VARCHAR(512) NOT NULL,
    "tier" VARCHAR(32) NOT NULL DEFAULT 'operations',
    "column_schema" JSONB NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "blurb" TEXT NOT NULL,
    "extraction_method" VARCHAR(32) NOT NULL DEFAULT 'xlsx_cells',
    "extraction_confidence" INTEGER NOT NULL DEFAULT 100,
    "source_region" JSONB,
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "superseded_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "registry_source_idx" ON "table_registry" ("source_path");
CREATE INDEX IF NOT EXISTS "registry_status_idx" ON "table_registry" ("status");
CREATE INDEX IF NOT EXISTS "registry_tier_idx" ON "table_registry" ("tier");
CREATE INDEX IF NOT EXISTS "registry_display_idx" ON "table_registry" ("display_name");