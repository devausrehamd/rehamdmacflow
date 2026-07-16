// src/drafting/production-handlers.ts
//
// The real StepHandlers, for driving executeRecipe on the live stack. The two
// LLM handlers are reused from handlers.ts; the five deterministic ones are
// implemented here against the real services.
//
// A deliberate property: these are REAL lookups, not stubs. Against an empty
// corpus and an empty data plane they return nothing - which is the correct
// result, and it flows through the pipeline exactly as it should: no retrieved
// sources -> generate_section has nothing to ground on -> insufficient_evidence
// rows -> gaps -> review required. Nothing is faked to make a document look
// finished. When the corpus is ingested, the same handlers return real sources.
//
// They are a FACTORY over the request context, because retrieval must run under
// the CALLER's access labels - a generation run may only build on documents the
// requesting user is entitled to see.

import { and, eq } from "drizzle-orm";
import type { RequestContext } from "../context.js";
import { getDefaultServices } from "../services.js";
import { db } from "../db/client.js";
import { draft_sets, draft_documents } from "../db/schema.js";
import { validateSection } from "./section-validator.js";
import { sectionSchema } from "./section-schema.js";
import { llmHandlers } from "./handlers.js";
import type { StepHandlers, OutputBag, StepOutputs } from "./executor.js";

/** A retrieved point as it sits in Qdrant. */
interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown> | null;
}

/** Do the caller's labels permit this chunk? An artifact is visible iff its
 *  access_labels intersect the caller's set. Fail closed: a chunk with no
 *  labels recorded is treated as restricted, not public. */
function permitted(payload: Record<string, unknown> | null | undefined, labels: string[]): boolean {
  const chunkLabels = (payload?.access_labels as string[] | undefined) ?? [];
  if (chunkLabels.length === 0) return false;
  return chunkLabels.some((l) => labels.includes(l));
}

export function makeProductionHandlers(ctx: RequestContext): StepHandlers {
  const svc = getDefaultServices(ctx);

  return {
    // Exact lookup of SOP sections by source. Scrolls the collection and keeps
    // chunks whose source_path contains the step's source fragment and that the
    // caller may see. Substring match (not a Qdrant keyword filter) because a
    // recipe pins a path FRAGMENT, and the payload index is exact-keyword; at
    // setup-corpus size an in-memory filter is fine. A large corpus would want a
    // full-text index on source_path instead - noted, not silently assumed away.
    async retrieve_sections(step): Promise<StepOutputs["retrieve_sections"]> {
      let points: QdrantPoint[] = [];
      try {
        const res = await svc.qdrant.scroll(svc.qdrantCollection, {
          limit: 1024,
          with_payload: true,
          with_vector: false,
        });
        points = (res.points ?? []) as QdrantPoint[];
      } catch {
        // Collection absent / unreachable: no sources, which the pipeline turns
        // into gaps and review - the honest result, never a fabricated section.
        points = [];
      }

      const wanted = step.sections.length > 0 ? new Set(step.sections) : null;
      const sections = points
        .filter((p) => {
          const path = p.payload?.source_path as string | undefined;
          if (!path || !path.includes(step.source)) return false;
          if (!permitted(p.payload, ctx.labels)) return false;
          if (wanted) {
            const sid = (p.payload?.section_id as string | undefined) ?? String(p.id);
            if (!wanted.has(sid)) return false;
          }
          return true;
        })
        .map((p) => ({
          id: (p.payload?.section_id as string | undefined) ?? String(p.id),
          text: (p.payload?.text as string | undefined) ?? "",
        }));

      return { source: step.source, sections };
    },

    // A structured-table query. The full query planner + tier routing is its own
    // surface (the data API); until a handler is wired to it, this resolves to
    // "no rows" HONESTLY rather than pretending. Recorded coverage says so, so a
    // reviewer sees that structured data was not consulted rather than assuming
    // it was and empty.
    async query_table(step): Promise<StepOutputs["query_table"]> {
      return {
        collection: step.collection,
        rows: [],
        coverage: "no structured-table results (the data-plane query path is not wired into generation yet)",
      };
    },

    // Pull an approved upstream document's exported reference set. Only APPROVED
    // sets of the named type qualify - a draft cannot ground another draft. The
    // export's id set is gathered from the approved documents' rows. No approved
    // prior -> empty set, which is correct: you cannot build on what does not
    // exist.
    async recall_prior(step): Promise<StepOutputs["recall_prior"]> {
      const sets = await db
        .select({ id: draft_sets.id })
        .from(draft_sets)
        .where(and(eq(draft_sets.document_type, step.documentType), eq(draft_sets.status, "approved")));

      const ids = new Set<string>();
      for (const s of sets) {
        const docs = await db.select().from(draft_documents).where(eq(draft_documents.set_id, s.id));
        for (const doc of docs) {
          for (const row of (doc.rows as Record<string, unknown>[]) ?? []) {
            const v = row[step.export] ?? row.id ?? row[`${step.export}_id`];
            if (v != null) ids.add(String(v));
          }
        }
      }
      return { documentType: step.documentType, export: step.export, ids };
    },

    // Re-affirm a generated section's validation. The generation step already
    // validated; this reads that result back from the bag so a recipe can gate
    // on it explicitly. A section not yet generated validates as empty (fail
    // closed) rather than throwing.
    async validate_section(step, bag: OutputBag): Promise<StepOutputs["validate_section"]> {
      const prior = Object.values(bag).find(
        (o) => o && "validation" in o && (o as StepOutputs["generate_section"]).sectionId === step.sectionId,
      ) as StepOutputs["generate_section"] | undefined;

      if (prior) return { sectionId: step.sectionId, validation: prior.validation };

      // No prior generation for this section: validate an empty produced set so
      // the section reads as incomplete, not as passed.
      const rubricSection = sectionSchema.parse(
        // The rubric is not passed to this handler; validate against the section
        // as it appears in the bag is impossible, so an empty validation is the
        // honest floor. Build a minimal empty validation via validateSection with
        // an empty spec-less set is not possible, so return an explicit empty.
        { id: step.sectionId, title: step.sectionId, cardinality: "array", groundedIn: [], fields: [] },
      );
      return {
        sectionId: step.sectionId,
        validation: validateSection(rubricSection, [], {}, new Set()),
      };
    },

    // The two LLM handlers, unchanged: the model fills declared fields and
    // returns one bit per criterion. They never see weights or compute a score.
    generate_section: llmHandlers.generate_section,
    judge: llmHandlers.judge,

    // Halt for a human. Generation persists the draft just before this returns
    // (the executor does the persist), so the draft is durable and reviewable at
    // the halt. The disposition itself is the reviewer's, made later.
    async require_human(): Promise<StepOutputs["require_human"]> {
      return { disposition: "pending" as const };
    },
  };
}
