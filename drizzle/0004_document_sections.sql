-- Document sections: the structural map (navigable heading hierarchy) that
-- enables structural retrieval. Chunks in Qdrant carry section_id; this table
-- resolves identifiers ("4.3"), parents, and children by exact lookup.

CREATE TABLE IF NOT EXISTS "document_sections" (
  "section_id" varchar(32) NOT NULL,
  "document_key" varchar(128) NOT NULL,
  "parent_section_id" varchar(32),
  "level" integer NOT NULL,
  "section_number" varchar(64),
  "heading_text" text NOT NULL,
  "heading_path" text NOT NULL,
  "order_index" integer NOT NULL,
  "source_path" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_sections_pk" PRIMARY KEY ("document_key", "section_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sections_parent_idx" ON "document_sections" ("parent_section_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sections_number_idx" ON "document_sections" ("section_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_sections_source_idx" ON "document_sections" ("source_path");