// scripts/smoke-test-export.ts
//
// The exporter role (Phase 6 of the agent-topology / custody-DAG spec). Proves
// the exporter is a PURE, deterministic function from a typed document model to
// bytes - which is what makes an exported document reproducible from the
// custody-recorded model. Golden output; no DB, no LLM.
//
//   - a fixed model renders to byte-identical, golden markdown
//   - rendering is deterministic (same model -> same bytes; field order stable)
//   - array vs single cardinality render as a table vs a list
//   - the provider wrapper (export:md) returns the same bytes
//
// Usage: npm run smoke:export

import { renderMarkdown, markdownExporter, type DocumentModel } from "../src/orchestrator/exporter.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

const model: DocumentModel = {
  documentType: "engineering-hours-budget",
  title: "Engineering Hours & Budget",
  sections: [
    {
      id: "summary",
      title: "Summary",
      cardinality: "single",
      rows: [{ labor_rate: 185, duration_weeks: 30 }],
    },
    {
      id: "breakdown",
      title: "Breakdown",
      cardinality: "array",
      rows: [
        { role: "EE", hours: 320 },
        { role: "ME", hours: 200 },
      ],
    },
  ],
};

// The golden output. Field order is the sorted union of row keys.
const GOLDEN = `# Engineering Hours & Budget

## Summary

- **duration_weeks:** 30
- **labor_rate:** 185

## Breakdown

| hours | role |
| --- | --- |
| 320 | EE |
| 200 | ME |
`;

function main(): void {
  console.log("=== Exporter (markdown) smoke test ===\n");

  const out = renderMarkdown(model);
  check("filename derives from the document type", out.filename === "engineering-hours-budget.md");
  check("content type is markdown", out.contentType === "text/markdown");
  check("renders byte-identical golden markdown", out.content === GOLDEN,
    out.content === GOLDEN ? "" : `\n--- got ---\n${out.content}\n--- want ---\n${GOLDEN}`);

  // Determinism: a second render of the same model is byte-identical.
  check("rendering is deterministic", renderMarkdown(model).content === out.content);

  // Structure: single -> list, array -> table.
  check("single section renders as a list", out.content.includes("- **labor_rate:** 185"));
  check("array section renders as a table", out.content.includes("| hours | role |"));

  // The provider wrapper yields identical bytes.
  const provider = markdownExporter();
  provider.run(model, { correlationId: "c", runId: "r", producedAt: "2026-01-01T00:00:00.000Z" }).then((res) => {
    check("export:md provider returns the same bytes", (res.result as { content: string }).content === GOLDEN);

    console.log("");
    if (failed === 0) console.log(`${GREEN}Exporter is sound.${NC}`);
    else console.log(`${RED}${failed} check(s) failed.${NC}`);
    process.exit(failed === 0 ? 0 : 1);
  });
}

main();
