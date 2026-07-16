// scripts/author-capa-recipe.ts
//
// Give the capa rubric a recipe + sections + a trajectory that points at a
// procedure THAT EXISTS in the corpus, so a CAPA can actually be generated and
// - unlike dfmea, whose FMEA procedure is deliberately absent - reach approval.
//
// The governing document is the ingested "Field Quality and CAPA Management"
// SOP (08_Governance_and_QMS/SOPs/Field_Quality_and_CAPA_Management.docx). The
// recipe retrieves it, generates the CAPA record grounded in it, judges, and
// halts for review.
//
// Authored programmatically (not via the GUI) as fixture setup. The structured
// recipe/section editors land next so a human can do this in the GUI.

import { readFileSync, writeFileSync } from "node:fs";

const path = "rubrics/capa.json";
const rubric = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

// The CAPA record: one document (cardinality single) with the five narrative
// fields the completeness criterion already requires. All generated prose,
// grounded in the SOP retrieved by the `sop` step.
rubric.sections = [
  {
    id: "capa_record",
    title: "Corrective and Preventive Action Record",
    cardinality: "single",
    groundedIn: ["sop"],
    fields: [
      { name: "problem_statement", type: "string", provenance: "generated", required: true,
        sopClause: "D2 - Problem Description" },
      { name: "root_cause_analysis", type: "string", provenance: "generated", required: true,
        sopClause: "D4 - Root Cause Analysis" },
      { name: "corrective_action", type: "string", provenance: "generated", required: true,
        sopClause: "D5/D6 - Corrective Action" },
      { name: "preventive_action", type: "string", provenance: "generated", required: true,
        sopClause: "D7 - Preventive Action" },
      { name: "verification_plan", type: "string", provenance: "generated", required: true,
        sopClause: "D6 - Verification of Effectiveness" },
    ],
  },
];

// The ordered recipe. Step ids form the intra-document DAG (inputs reference
// prior step ids).
rubric.recipe = {
  steps: [
    {
      id: "sop",
      kind: "retrieve_sections",
      // A path fragment of the real SOP - the retrieval handler filters chunks
      // whose source_path contains this.
      source: "Field_Quality_and_CAPA_Management",
      sections: [],
    },
    { id: "gen", kind: "generate_section", sectionId: "capa_record", bestOf: 1, inputs: ["sop"] },
    { id: "val", kind: "validate_section", sectionId: "capa_record", inputs: ["gen"] },
    { id: "score", kind: "judge", criteria: [], inputs: ["gen"] },
    { id: "human", kind: "require_human", prompt: "Review the CAPA record before approval.", inputs: ["score"] },
  ],
};

// Trajectory: the CAPA SOP must have been consulted. documentType tokens
// {capa, management} are a subset of the retrieved source
// "Field_Quality_and_CAPA_Management", so a real retrieval satisfies it; an
// empty one does not.
rubric.trajectory = {
  description: "A CAPA must be grounded in the controlled Field Quality and CAPA Management procedure.",
  required: [
    {
      kind: "document",
      id: "capa_sop",
      documentType: "capa-management",
      reason:
        "The CAPA methodology (8D), thresholds, and disposition path are defined by the controlled Field Quality and CAPA Management SOP; a CAPA produced without consulting it is ungoverned.",
    },
  ],
  forbidden: [],
};

writeFileSync(path, JSON.stringify(rubric, null, 2) + "\n", "utf8");
console.log("  capa.json: added 1 section, 5-step recipe, and a document trajectory requiring the CAPA SOP.");
