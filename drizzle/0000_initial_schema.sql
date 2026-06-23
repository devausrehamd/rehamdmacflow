-- Initial schema for the QMS Agent
-- Generated to match src/db/schema.ts
--
-- Apply with: npm run db:migrate

CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "email" VARCHAR(255) NOT NULL UNIQUE,
    "password_hash" VARCHAR(255) NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "display_name" VARCHAR(255),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "last_login_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "drafts" (
    "id" VARCHAR(64) PRIMARY KEY,
    "query_id" VARCHAR(64),
    "doc_type" VARCHAR(32) NOT NULL,
    "project_id" VARCHAR(64),
    "brief" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(32) NOT NULL DEFAULT 'pending_review',
    "author_id" UUID NOT NULL REFERENCES "users"("id"),
    "reviewer_id" UUID REFERENCES "users"("id"),
    "review_comment" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "reviewed_at" TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS "drafts_author_idx" ON "drafts" ("author_id");
CREATE INDEX IF NOT EXISTS "drafts_status_idx" ON "drafts" ("status");
CREATE INDEX IF NOT EXISTS "drafts_project_idx" ON "drafts" ("project_id");

CREATE TABLE IF NOT EXISTS "decisions" (
    "id" SERIAL PRIMARY KEY,
    "scope" VARCHAR(64) NOT NULL,
    "decision" TEXT NOT NULL,
    "rationale" TEXT,
    "established_by" UUID NOT NULL REFERENCES "users"("id"),
    "established_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "superseded_by" INTEGER
);

CREATE INDEX IF NOT EXISTS "decisions_scope_idx" ON "decisions" ("scope");
CREATE INDEX IF NOT EXISTS "decisions_status_idx" ON "decisions" ("status");

CREATE TABLE IF NOT EXISTS "lessons" (
    "id" SERIAL PRIMARY KEY,
    "doc_type" VARCHAR(32) NOT NULL,
    "context_snippet" TEXT,
    "lesson" TEXT NOT NULL,
    "issue" TEXT,
    "source_doc_id" VARCHAR(64),
    "source_doc_version" VARCHAR(32),
    "reviewer_id" UUID NOT NULL REFERENCES "users"("id"),
    "source_draft_id" VARCHAR(64),
    "status" VARCHAR(32) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "lessons_doc_type_idx" ON "lessons" ("doc_type");
CREATE INDEX IF NOT EXISTS "lessons_status_idx" ON "lessons" ("status");

CREATE TABLE IF NOT EXISTS "audit_log" (
    "id" SERIAL PRIMARY KEY,
    "request_id" VARCHAR(64) NOT NULL,
    "user_id" UUID REFERENCES "users"("id"),
    "user_email" VARCHAR(255),
    "user_role" VARCHAR(32),
    "method" VARCHAR(16) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "ip_address" VARCHAR(64),
    "user_agent" TEXT,
    "resource_ids" JSONB,
    "details" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "audit_user_idx" ON "audit_log" ("user_id");
CREATE INDEX IF NOT EXISTS "audit_request_idx" ON "audit_log" ("request_id");
CREATE INDEX IF NOT EXISTS "audit_created_idx" ON "audit_log" ("created_at");