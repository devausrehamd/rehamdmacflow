 // scripts/smoke-test-dependency.ts
//
// The document dependency graph. Entirely deterministic - no LLM, no Postgres,
// no Qdrant. Validates:
//
//   - the REAL rubrics form a valid graph (no cycles, exports line up)
//   - plan ordering: prerequisites before dependents, target last
//   - approved prerequisites are marked satisfied, not regenerated
//   - a cross-domain prerequisite BLOCKS and names itself for the orchestrator
//   - a cycle is caught at LOAD, not at generation time
//   - consuming an export the upstream never declared is caught at load
//
// Usage: npm run smoke:dependency

import {
  buildGraph,
  planFor,
  pendingSteps,
  DependencyError,
  type DependencyGraph,
} from "../src/drafting/dependency.js";
import { loadRubrics } from "../src/drafting/rubric-loader.js";
import type { Rubric } from "../src/drafting/rubric-schema.js";

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

const DOMAIN = "engineering";

/** Minimal synthetic rubric, so edge cases need no files on disk. */
function stub(
  documentType: string,
  requires: { documentType: string; domain: string; consume: string[] }[] = [],
  exportNames: string[] = [],
): Rubric {
  return {
    documentType,
    displayName: documentType,
    version: "0",
    aliases: [],
    reviewThreshold: 0.8,
    requires: requires.map((r) => ({ ...r, reason: "" })),
    exports: Object.fromEntries(exportNames.map((n) => [n, { description: "", schema: "any" }])),
    expert: { description: "", criteria: [] },
    objective: { description: "", criteria: [{ id: "x", description: "x", weight: 100 }] },
    trajectory: { description: "", requiredSources: [], forbiddenSources: [] },
  } as Rubric;
}

function graphOf(...rubrics: Rubric[]): DependencyGraph {
  return buildGraph(new Map(rubrics.map((r) => [r.documentType, r])), DOMAIN);
}

function main(): void {
  console.log("=== Document dependency graph smoke test ===\n");

  // --- The REAL rubrics must form a valid graph ---
  const loaded = loadRubrics();
  const real = new Map([...loaded].map(([k, v]) => [k, v.rubric]));
  let realGraph: DependencyGraph | null = null;
  try {
    realGraph = buildGraph(real, DOMAIN);
    check(`real rubrics build a valid graph (${real.size} types)`, true);
  } catch (err) {
    failed++;
    console.log(`${RED}FAIL${NC} real rubrics build a valid graph - ${err instanceof Error ? err.message : err}`);
  }

  if (realGraph) {
    // dfmea requires an approved risk-register
    const cold = planFor(realGraph, "dfmea", new Set(), DOMAIN);
    check("dfmea plan is ordered: risk-register before dfmea",
      cold.steps.map((s) => s.documentType).join(",") === "risk-register,dfmea",
      cold.steps.map((s) => s.documentType).join(","));
    check("  target is last", cold.steps[cold.steps.length - 1].documentType === "dfmea");
    check("  both must be generated", pendingSteps(cold).length === 2);
    check("  not blocked (same domain)", !cold.blocked);
    check("  dfmea consumes riskItems from risk-register",
      cold.steps[1].consumedBy?.exports.includes("riskItems") === true ||
      cold.steps[0].consumedBy?.exports.includes("riskItems") === true);

    // With the risk register approved, it is satisfied and not regenerated.
    const warm = planFor(realGraph, "dfmea", new Set(["risk-register"]), DOMAIN);
    check("approved risk-register is satisfied, not regenerated",
      warm.steps.find((s) => s.documentType === "risk-register")?.status === "satisfied");
    check("  only dfmea remains to generate", pendingSteps(warm).length === 1);

    // capa has no prerequisites.
    const capa = planFor(realGraph, "capa", new Set(), DOMAIN);
    check("capa plan is a single step", capa.steps.length === 1 && capa.steps[0].documentType === "capa");
  }

  // --- Cross-domain prerequisite BLOCKS ---
  const crossDomain = graphOf(
    stub("export-control-list", [
      { documentType: "dfmea", domain: "trade-compliance", consume: ["failureModes"] },
    ]),
  );
  const blockedPlan = planFor(crossDomain, "export-control-list", new Set(), DOMAIN);
  check("cross-domain prerequisite blocks the plan", blockedPlan.blocked);
  check("  the external step is named", blockedPlan.steps.some((s) => s.status === "external"));
  check("  message points at the orchestrator", /orchestrator/i.test(blockedPlan.message ?? ""));

  // --- Cycle caught at LOAD ---
  let cycleErr: DependencyError | null = null;
  try {
    graphOf(
      stub("a", [{ documentType: "b", domain: DOMAIN, consume: [] }]),
      stub("b", [{ documentType: "a", domain: DOMAIN, consume: [] }]),
    );
  } catch (e) {
    cycleErr = e instanceof DependencyError ? e : null;
  }
  check("cycle is caught at load", cycleErr?.code === "cycle");
  check("  cycle path is reported", /a -> b -> a|b -> a -> b/.test(cycleErr?.message ?? ""), cycleErr?.message);

  // --- Self-cycle ---
  let selfErr: DependencyError | null = null;
  try {
    graphOf(stub("solo", [{ documentType: "solo", domain: DOMAIN, consume: [] }]));
  } catch (e) {
    selfErr = e instanceof DependencyError ? e : null;
  }
  check("self-dependency is caught", selfErr?.code === "cycle");

  // --- Consuming an undeclared export ---
  let exportErr: DependencyError | null = null;
  try {
    graphOf(
      stub("upstream", [], ["riskItems"]),
      stub("downstream", [{ documentType: "upstream", domain: DOMAIN, consume: ["nonexistent"] }]),
    );
  } catch (e) {
    exportErr = e instanceof DependencyError ? e : null;
  }
  check("consuming an undeclared export is caught at load", exportErr?.code === "unknown_export");
  check("  it names what IS exported", /riskItems/.test(exportErr?.message ?? ""));

  // --- Prerequisite with no rubric ---
  let unknownErr: DependencyError | null = null;
  try {
    graphOf(stub("orphan", [{ documentType: "ghost", domain: DOMAIN, consume: [] }]));
  } catch (e) {
    unknownErr = e instanceof DependencyError ? e : null;
  }
  check("local prerequisite with no rubric is caught at load", unknownErr?.code === "unknown_prerequisite");

  // --- Diamond: two dependents share one prerequisite ---
  const diamond = graphOf(
    stub("base", [], ["items"]),
    stub("left", [{ documentType: "base", domain: DOMAIN, consume: ["items"] }], ["l"]),
    stub("right", [{ documentType: "base", domain: DOMAIN, consume: ["items"] }], ["r"]),
    stub("top", [
      { documentType: "left", domain: DOMAIN, consume: ["l"] },
      { documentType: "right", domain: DOMAIN, consume: ["r"] },
    ]),
  );
  const dplan = planFor(diamond, "top", new Set(), DOMAIN);
  const order = dplan.steps.map((s) => s.documentType);
  check("diamond: base appears exactly once", order.filter((t) => t === "base").length === 1, order.join(","));
  check("diamond: base precedes left and right",
    order.indexOf("base") < order.indexOf("left") && order.indexOf("base") < order.indexOf("right"));
  check("diamond: top is last", order[order.length - 1] === "top", order.join(","));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Dependency graph is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();