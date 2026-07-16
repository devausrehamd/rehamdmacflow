-- Stamp the agent's operating mode on every custody event.
--
-- Without this, an auditor cannot tell a production run from a debug run after
-- the fact - and debug runs may be governed by an UNCOMMITTED draft rubric, so
-- the distinction is the difference between a controlled record and a
-- provisional one.
--
-- The value is hashed into the chain (see hashEntry), so it is tamper-evident:
-- flipping "debug" to "production" in the database breaks chain verification.
--
-- Nullable, and the hash OMITS the field entirely when absent, so rows written
-- before this column still verify byte-identically. A null mode means "written
-- before modes existed", which is honest; it does not mean production.

ALTER TABLE "custody_events" ADD COLUMN IF NOT EXISTS "mode" varchar(16);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "custody_events_mode_idx" ON "custody_events" ("mode");
