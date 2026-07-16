-- Keep the per-run verdicts behind a k-sampling batch, not just the aggregate.
--
-- runBatch already produces CriterionVerdict[][] - one verdict per criterion per
-- run, each with the judge's own rationale and any deterministic pattern hits -
-- and the endpoint destructured `stats` out and dropped `runs` on the floor.
--
-- That discarded the evidence for the instrument's most useful signal. The GUI
-- can say a criterion is a COIN-FLIP, but "the model cannot decide" is the
-- beginning of a diagnosis, not the end of one: an editor needs to read the
-- rationales from the runs that passed against the ones that failed to see WHY
-- the wording is ambiguous. Without them the tool reports a problem and hides
-- its cause.
--
-- Nullable: batches recorded before this column exist, and their runs are gone
-- for good. Null means "not captured", not "no verdicts".

ALTER TABLE "rubric_draft_batches" ADD COLUMN IF NOT EXISTS "runs" jsonb;
