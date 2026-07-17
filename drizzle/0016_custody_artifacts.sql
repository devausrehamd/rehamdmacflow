-- Content-addressed artifact store (Phase 1 of the agent-topology / custody-DAG spec).
--
-- An artifact is an immutable unit of gathered or produced data (e.g. one
-- researcher's result). Its primary key is the sha256 of its own canonical JSON,
-- so identical content yields one row no matter how many times, or in what
-- order, concurrent producers write it. This is what makes parallel research
-- race-free: a hash depends ONLY on the artifact's bytes, never on a chain head
-- or a predecessor.
--
-- The linear custody ledger (custody_events) references these by hash; tampering
-- with an artifact changes its hash and breaks the referring event. This table
-- has no update path in application code - putArtifact only ever inserts
-- (ON CONFLICT DO NOTHING). A record you can edit is not evidence.

CREATE TABLE IF NOT EXISTS "custody_artifacts" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"capability" varchar(64),
	"producer" varchar(128),
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_artifacts_capability_idx" ON "custody_artifacts" ("capability");
