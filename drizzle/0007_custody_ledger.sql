-- Custody ledger: append-only, hash-chained record of document production.
-- No UPDATE and no DELETE are ever issued against custody_events - the only
-- writer is appendEvent, which only inserts. A custody record you can edit is
-- not evidence.

CREATE TABLE IF NOT EXISTS "custody_events" (
  "seq" bigserial PRIMARY KEY,
  "correlation_id" varchar(64) NOT NULL,
  "run_id" varchar(64) NOT NULL,
  "domain" varchar(64) NOT NULL,
  "event_type" varchar(48) NOT NULL,
  "user_id" varchar(64),
  "decision_id" varchar(64),
  "policy_hash" varchar(64),
  "payload" jsonb NOT NULL,
  "prev_hash" varchar(64) NOT NULL,
  "entry_hash" varchar(64) NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_correlation_idx" ON "custody_events" ("correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_run_idx" ON "custody_events" ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_entry_hash_idx" ON "custody_events" ("entry_hash");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "custody_anchors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "domain" varchar(64) NOT NULL,
  "head_seq" bigint NOT NULL,
  "head_hash" varchar(64) NOT NULL,
  "method" varchar(32) NOT NULL,
  "proof" text NOT NULL,
  "anchored_at" timestamptz NOT NULL DEFAULT now()
);