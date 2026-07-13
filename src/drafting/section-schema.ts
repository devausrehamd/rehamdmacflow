// src/drafting/section-schema.ts
//
// The declared structure of a document section - the panels, cut before the
// seamstress touches them.
//
// This is where "what goes in a DFMEA" lives. It is TRANSCRIBED from the SOP by
// a domain expert, not inferred by a model. A vector search over an SOP returns
// plausibly-related passages; a model guessing the required fields from them
// will be MOSTLY right, which is worse than reliably wrong because the omission
// is invisible. Structure is declared; only CONTENT is retrieved.
//
// The load-bearing idea is PROVENANCE per field:
//
//   retrieved  - must trace to a retrieved source. The model transcribes; it
//                does not invent. A value with no source is a fabrication.
//   generated  - the model composes prose (a rationale, a description) from
//                grounded context. Still grounded, but not a verbatim lift.
//   computed   - CODE calculates it from other fields. The model never touches
//                it. RPN = severity x occurrence x detection is arithmetic, and
//                a 7B does not do arithmetic in a controlled document any more
//                than it writes SQL.
//
// A field that cannot be filled from evidence is emitted as insufficient_evidence
// - never fabricated. That gap then fails a must-pass criterion and forces human
// review. A gap becomes evidence, not a silent hole.

import { z } from "zod";

export const FIELD_PROVENANCE = ["retrieved", "generated", "computed"] as const;
export type FieldProvenance = (typeof FIELD_PROVENANCE)[number];

export const FIELD_TYPES = ["string", "integer", "number", "enum", "identifier", "reference"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const fieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.enum(FIELD_TYPES),
    provenance: z.enum(FIELD_PROVENANCE),

    required: z.boolean().default(true),

    // For enum fields: the closed value set (from the SOP's defined scale).
    domain: z.array(z.union([z.string(), z.number()])).optional(),
    // For integer/number: inclusive bounds (the SOP's rating scale).
    min: z.number().optional(),
    max: z.number().optional(),

    // For computed fields: the arithmetic, over other field names in this
    // section. Restricted to * + - so it cannot become a scripting surface.
    // e.g. "severity * occurrence * detection".
    formula: z.string().optional(),

    // For reference fields: which upstream export the value must be a member
    // of. A cross-reference is validated by SET MEMBERSHIP, not trusted.
    // e.g. "risk-register.riskItems.id".
    referenceExport: z.string().optional(),

    // The SOP clause this field is transcribed from. Provenance for the
    // STRUCTURE itself - an auditor can trace the schema to the procedure.
    sopClause: z.string().default(""),
  })
  .superRefine((f, ctx) => {
    if (f.provenance === "computed" && !f.formula) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `computed field '${f.name}' needs a formula` });
    }
    if (f.formula && f.provenance !== "computed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `field '${f.name}' has a formula but is not computed` });
    }
    if (f.type === "enum" && (!f.domain || f.domain.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `enum field '${f.name}' needs a domain` });
    }
    if (f.type === "reference" && !f.referenceExport) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `reference field '${f.name}' needs a referenceExport` });
    }
  });

export type FieldSpec = z.infer<typeof fieldSchema>;

export const sectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),

  // Is this section a single record, or a repeating row set (a table)?
  cardinality: z.enum(["single", "array"]).default("array"),

  // Which prior step outputs and retrieved sources ground this section.
  // These names index into the recipe's step outputs (intra-document DAG).
  groundedIn: z.array(z.string()).default([]),

  fields: z.array(fieldSchema).min(1),
});

export type SectionSpec = z.infer<typeof sectionSchema>;