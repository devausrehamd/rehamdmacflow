-- The DAG History store: durable, write-ahead, per-agent trajectory (Stage 3 of
-- the agent-platform control plane).
--
-- Distinct from the tamper-evident custody chain (custody_events) and from
-- agent_run_steps, which sink.ts designates ephemeral (it dies with the agent).
-- This is the record that SURVIVES an agent VM being destroyed: each step is
-- appended as it completes (write-ahead), so a hard crash loses nothing already
-- written.
--
-- Append-only and idempotent on (correlation_id, agent_guid, seq): each agent
-- writes its OWN lane, so no two writers ever contend, and a retried post is a
-- no-op (ON CONFLICT DO NOTHING). Cross-agent order is the artifact-hash DAG the
-- custody chain already holds - there is no global sequence here, deliberately.

CREATE TABLE IF NOT EXISTS "agent_trajectory" (
	"correlation_id" varchar(64) NOT NULL,
	"agent_guid"     varchar(64) NOT NULL,
	"seq"            integer     NOT NULL,
	"capability"     varchar(64),
	"kind"           varchar(48) NOT NULL,
	"input"          jsonb,
	"output_ref"     varchar(64),
	"status"         varchar(16) NOT NULL,
	"error"          text,
	-- Terminal marker (good or bad): its ABSENCE next to an expired lease is the
	-- signal that an agent died mid-operation at the last recorded seq.
	"terminal"       boolean     NOT NULL DEFAULT false,
	"outcome"        varchar(16),
	"reason"         text,
	"recorded_at"    timestamp with time zone NOT NULL DEFAULT now(),
	CONSTRAINT "agent_trajectory_pk" PRIMARY KEY ("correlation_id","agent_guid","seq")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_trajectory_correlation_idx" ON "agent_trajectory" ("correlation_id");
