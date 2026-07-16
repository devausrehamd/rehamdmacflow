-- Record WHO authored a draft set, so APPROVER != AUTHOR can actually be
-- enforced.
--
-- The check previously read `originating_query_id.includes(user.id)`, but that
-- column holds a query id (qry_<hex>) and never contains a user id, so the
-- comparison was permanently false and the control never fired.
--
-- Nullable on purpose: rows written before this migration have a genuinely
-- unknown author, and inventing one would be worse than admitting it. The
-- disposition endpoint FAILS CLOSED on null - if we cannot prove the approver
-- is not the author, we must not approve.

ALTER TABLE "draft_sets" ADD COLUMN IF NOT EXISTS "author_id" varchar(64);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "draft_sets_author_idx" ON "draft_sets" ("author_id");
