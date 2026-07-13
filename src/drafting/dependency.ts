 // src/drafting/dependency.ts
//
// The document dependency graph. Deterministic, no LLM.
//
// A DFMEA cites RISK-014 from an approved risk register. An export control
// list cites failure modes from an approved DFMEA. Those references must be:
//
//   ORDERED       - a prerequisite is generated first
//   APPROVED      - your own DFMEA rubric forbids grounding in drafts/
//   STRUCTURAL    - the downstream CODE reads upstream `exports`, so a
//                   fabricated cross-reference is a set-membership failure,
//                   not a plausible sentence nobody catches
//   TRACEABLE     - an edge records what was consumed, so a regenerated
//                   upstream marks downstream documents STALE
//
// The graph is not a build that runs to completion. It is a workflow with a
// human approval gate on every edge. Ordering is the easy half; invalidation
// and approval are what make a cross-reference trustworthy.
//
// Auto-cascading is deliberately NOT supported. A casual request for an export
// control list must not silently produce a DFMEA - a controlled document
// nobody asked for, needing its own review from its own approver. The plan is
// PROPOSED; a human confirms it. Propose, approve, execute - as with writes,
// drafts, and plans.

import type { Rubric } from "./rubric-schema.js";

export class DependencyError extends Error {
  constructor(
    public readonly code: "cycle" | "unknown_prerequisite" | "unknown_export",
    message: string,
  ) {
    super(message);
    this.name = "DependencyError";
  }
}

export interface RequireEdge {
  documentType: string;
  domain: string;
  consume: string[];
  reason: string;
}

export interface GraphNode {
  documentType: string;
  requires: RequireEdge[];
  exports: string[];
}

export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
}

/**
 * Build and VALIDATE the graph. Three checks, all at load time - a cycle or a
 * missing export discovered during generation is discovered too late.
 *
 *   1. every local prerequisite resolves to a known document type
 *   2. every `consume` names an export the upstream actually declares
 *   3. no cycles
 *
 * Prerequisites in ANOTHER domain are not resolvable here (that agent's
 * rubrics do not ship in this image), so checks 1 and 2 are skipped for them.
 * They are surfaced in the plan as `external` and block local execution.
 */
export function buildGraph(rubrics: Map<string, Rubric>, localDomain: string): DependencyGraph {
  const nodes = new Map<string, GraphNode>();

  for (const [type, rubric] of rubrics) {
    nodes.set(type, {
      documentType: type,
      requires: rubric.requires.map((r) => ({
        documentType: r.documentType,
        domain: r.domain,
        consume: r.consume,
        reason: r.reason,
      })),
      exports: Object.keys(rubric.exports),
    });
  }

  // 1 + 2: prerequisite and export validation (local edges only)
  for (const node of nodes.values()) {
    for (const edge of node.requires) {
      if (edge.domain !== localDomain) continue;

      const upstream = nodes.get(edge.documentType);
      if (!upstream) {
        throw new DependencyError(
          "unknown_prerequisite",
          `'${node.documentType}' requires '${edge.documentType}' in this domain, but no such ` +
            `document type is registered. A prerequisite with no rubric cannot be evaluated.`,
        );
      }
      for (const name of edge.consume) {
        if (!upstream.exports.includes(name)) {
          throw new DependencyError(
            "unknown_export",
            `'${node.documentType}' consumes '${name}' from '${edge.documentType}', which ` +
              `exports only [${upstream.exports.join(", ") || "nothing"}]. A cross-reference to ` +
              `an undeclared export cannot be validated.`,
          );
        }
      }
    }
  }

  // 3: cycles. DFS with a colour marking - white unvisited, grey on the stack,
  // black finished. A grey node reached again closes a cycle.
  const state = new Map<string, "grey" | "black">();
  const stack: string[] = [];

  const visit = (type: string): void => {
    const colour = state.get(type);
    if (colour === "black") return;
    if (colour === "grey") {
      const from = stack.indexOf(type);
      const loop = [...stack.slice(from), type].join(" -> ");
      throw new DependencyError("cycle", `Dependency cycle: ${loop}`);
    }

    state.set(type, "grey");
    stack.push(type);
    const node = nodes.get(type);
    if (node) {
      for (const edge of node.requires) {
        if (edge.domain !== localDomain) continue; // external edges cannot cycle locally
        visit(edge.documentType);
      }
    }
    stack.pop();
    state.set(type, "black");
  };

  for (const type of nodes.keys()) visit(type);

  return { nodes };
}

// ---------------------------------------------------------------------------
// Plan resolution
// ---------------------------------------------------------------------------

export type StepStatus =
  /** An approved instance already exists. Nothing to do. */
  | "satisfied"
  /** Must be generated here, in this domain, before the target. */
  | "must_generate"
  /** Belongs to another domain. This agent cannot build it. */
  | "external";

export interface PlanStep {
  documentType: string;
  domain: string;
  status: StepStatus;
  /** Which upstream exports the DEPENDENT reads. Empty for the target itself. */
  consumedBy?: { documentType: string; exports: string[] };
  reason?: string;
}

export interface GenerationPlan {
  target: string;
  /** Topologically ordered. The target is always last. */
  steps: PlanStep[];
  /** True when a prerequisite cannot be produced here. The orchestrator must resolve it. */
  blocked: boolean;
  /** Human-readable explanation when blocked. */
  message?: string;
}

/**
 * Resolve what must happen before `target` can be generated.
 *
 * `approved` is the set of document types with an approved instance. Note the
 * granularity: this is type-level, not subject-level. A real system asks "is
 * there an approved DFMEA *for RC4*", which needs the draft set to carry its
 * subject. Type-level is the honest v1 and is flagged as such.
 *
 * PURE. Takes the graph and a set; touches no database. Testable without an
 * LLM, without Postgres, and without a running agent.
 */
export function planFor(
  graph: DependencyGraph,
  target: string,
  approved: Set<string>,
  localDomain: string,
): GenerationPlan {
  const node = graph.nodes.get(target);
  if (!node) {
    throw new DependencyError("unknown_prerequisite", `Unknown document type '${target}'.`);
  }

  const steps: PlanStep[] = [];
  const emitted = new Set<string>();
  let blocked = false;
  const blockers: string[] = [];

  const walk = (type: string, consumer?: { documentType: string; exports: string[] }): void => {
    if (emitted.has(type)) return;

    const n = graph.nodes.get(type);

    // A type we have no rubric for, reached via an external edge.
    if (!n) {
      steps.push({
        documentType: type,
        domain: consumer ? "external" : localDomain,
        status: "external",
        consumedBy: consumer,
      });
      emitted.add(type);
      blocked = true;
      blockers.push(type);
      return;
    }

    for (const edge of n.requires) {
      if (edge.domain !== localDomain) {
        if (!emitted.has(edge.documentType)) {
          steps.push({
            documentType: edge.documentType,
            domain: edge.domain,
            status: "external",
            consumedBy: { documentType: type, exports: edge.consume },
            reason: edge.reason,
          });
          emitted.add(edge.documentType);
          blocked = true;
          blockers.push(`${edge.documentType} (${edge.domain})`);
        }
        continue;
      }
      walk(edge.documentType, { documentType: type, exports: edge.consume });
    }

    steps.push({
      documentType: type,
      domain: localDomain,
      status: approved.has(type) ? "satisfied" : "must_generate",
      consumedBy: consumer,
    });
    emitted.add(type);
  };

  walk(target);

  const message = blocked
    ? `Cannot produce '${target}' here: it depends on ${blockers.join(", ")}, which ` +
      `belong to another domain. This agent has no rubric for them and cannot evaluate ` +
      `what it would produce. Route this through the orchestrator.`
    : undefined;

  return { target, steps, blocked, message };
}

/** Steps that must actually be generated, in order. Excludes satisfied and external. */
export function pendingSteps(plan: GenerationPlan): PlanStep[] {
  return plan.steps.filter((s) => s.status === "must_generate");
}