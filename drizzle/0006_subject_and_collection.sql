-- Project scoping and collection membership.
--
-- project    scopes a prerequisite: an approved risk register for Denali must
--            not satisfy a DFMEA for Summit.
-- collection enables enumeration: "all risk registers" is a set-membership
--            query over this column, not a top-K vector search.
--
-- Both nullable and both default NULL: a document declaring neither satisfies
-- no prerequisite and joins no aggregate. Fail closed.

ALTER TABLE "table_registry" ADD COLUMN IF NOT EXISTS "project" varchar(64);
--> statement-breakpoint
ALTER TABLE "table_registry" ADD COLUMN IF NOT EXISTS "collection" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "table_registry_collection_idx" ON "table_registry" ("collection");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "table_registry_project_idx" ON "table_registry" ("project");--> statement-breakpoint

ALTER TABLE "draft_sets" ADD COLUMN IF NOT EXISTS "subject" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_sets_subject_idx" ON "draft_sets" ("subject");