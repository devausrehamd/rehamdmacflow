-- Every prompt sent to the model, and what came back.
--
-- The last hole in the trace. agent_run_steps records what each NODE was given
-- and returned, but the prompt is assembled inside a node and handed straight
-- to the client, so it never reaches the graph state - a state-level wrapper
-- cannot see it. Without it you can see that `draft` was handed twelve chunks
-- and produced a wrong answer, and still not know whether the chunk holding the
-- value ever made it into the prompt.
--
-- That is the difference between "the model ignored what it was shown" and "the
-- model was never shown it", which is the whole question.
--
-- Same rules as agent_run_steps: content, erasable, OUTSIDE the hash chain.
-- Custody proves; this explains.

CREATE TABLE IF NOT EXISTS "agent_llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ties the call to the run and the node that made it. Attributed via the
  -- run scope, so a call from a helper several layers below a node still lands
  -- on that node.
  "correlation_id" varchar(64) NOT NULL,
  "run_id" varchar(64) NOT NULL,
  "node" varchar(64),
  "seq" integer NOT NULL,

  -- Exactly what the model was asked, and exactly what it said.
  "model" varchar(128),
  "prompt" text NOT NULL,
  "completion" text,

  "status" varchar(16) NOT NULL DEFAULT 'ok',
  "error" text,
  "latency_ms" integer NOT NULL DEFAULT 0,

  "user_id" varchar(64),
  "mode" varchar(16),
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_llm_calls_correlation_idx" ON "agent_llm_calls" ("correlation_id", "seq");
