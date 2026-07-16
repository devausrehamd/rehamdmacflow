-- What went INTO and OUT OF every node of the graph, per run.
--
-- This is the evidence layer, and it is deliberately NOT the custody ledger.
-- Custody is immutable, hash-chained, and holds references only - chunk ids,
-- not chunk text - because an append-only chain containing document text and
-- PII is a retention problem you cannot delete your way out of. That decision
-- stands.
--
-- But it left the diagnostic question unanswerable: custody proves section 4.2
-- was retrieved, not what 4.2 said, so "the model ignored a value that was
-- retrieved" and "the value was never retrieved" look identical in the record.
-- Telling those apart is the whole reason an engineer opens a low-scoring run.
--
-- So: content lives here, ERASABLE and outside the chain; proof stays in
-- custody. Rows can be dropped on a retention schedule without touching the
-- chain's integrity, which is exactly the property the split buys.
--
-- `input` is the state a node received; `output` is the delta it returned.
-- Both are REDACTED at write time (see instrument.ts) - the graph state carries
-- the caller's bearer token, and a diagnostic table an engineer browses must
-- never hold live credentials.

CREATE TABLE IF NOT EXISTS "agent_run_steps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The run. correlation_id is the durable key that ties this to custody.
  "correlation_id" varchar(64) NOT NULL,
  "run_id" varchar(64) NOT NULL,
  "query_id" varchar(64),

  -- Order within the run, and which node produced it.
  "seq" integer NOT NULL,
  "node" varchar(64) NOT NULL,

  -- The evidence. Redacted, never truncated: a half-stored input is worse than
  -- none, because it reads as complete.
  "input" jsonb,
  "output" jsonb,

  -- ok | error. A node that threw is the most interesting row in the table, so
  -- failures are recorded, not dropped.
  "status" varchar(16) NOT NULL DEFAULT 'ok',
  "error" text,
  "latency_ms" integer NOT NULL DEFAULT 0,

  -- WHOSE run. Retrieval is filtered by the caller's access labels, so this row
  -- holds content scoped to THIS user - which is why reads are restricted to
  -- the owner unless the reader holds audit:read.
  "user_id" varchar(64),
  -- production | debug: a debug run may have been judged by an uncommitted
  -- rubric, and its evidence must not be mistaken for a controlled record.
  "mode" varchar(16),

  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_correlation_idx" ON "agent_run_steps" ("correlation_id", "seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_user_idx" ON "agent_run_steps" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_run_steps_recorded_idx" ON "agent_run_steps" ("recorded_at");
