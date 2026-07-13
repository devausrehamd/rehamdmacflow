-- Live source registry: durable records of live/external services the agent
-- queries at request time (not snapshotted into RAG).

CREATE TABLE IF NOT EXISTS "live_source_registry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" varchar(512) NOT NULL,
  "source_type" varchar(32) DEFAULT 'web-api' NOT NULL,
  "lane" varchar(16) DEFAULT 'live' NOT NULL,
  "endpoint" text NOT NULL,
  "method" varchar(8) DEFAULT 'GET' NOT NULL,
  "description" text NOT NULL,
  "queryable_fields" jsonb NOT NULL,
  "auth" varchar(32) DEFAULT 'service-token' NOT NULL,
  "tier" varchar(32) DEFAULT 'operations' NOT NULL,
  "source_path" text NOT NULL,
  "content_hash" varchar(64) NOT NULL,
  "status" varchar(32) DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_source_status_idx" ON "live_source_registry" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_source_lane_idx" ON "live_source_registry" ("lane");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "live_source_name_idx" ON "live_source_registry" ("name");