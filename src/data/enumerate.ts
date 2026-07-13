// src/data/enumerate.ts
//
// "All risk registers" is an ENUMERATION over the registry, not a top-K vector
// search.
//
// THE BUG THIS FIXES. The table lane does:
//
//     qdrant.search(collection, { vector, limit: TABLE_TOP_K, filter: {...} })
//
// Ask "what issues are common across all risk registers" with nine registers
// indexed and TABLE_TOP_K = 3, and the agent queries the three most
// semantically similar blurbs, finds what is common among *those*, and reports
// it as common across the registers. No error. No warning. Nothing in the
// answer indicates six registers were never looked at. It is confidently,
// silently incomplete - the worst failure a controlled document can have.
//
// Retrieval discovers THAT a kind of thing exists. The registry enumerates
// WHICH ones. Set membership is an exact query; similarity is the wrong
// instrument, exactly as it was for "section 4.3".
//
// Two invariants:
//   - a member the caller cannot see is EXCLUDED and the exclusion RECORDED
//   - a member that breaks the collection's schema contract is EXCLUDED and
//     REPORTED, never silently coerced into a union

import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { table_registry } from "../db/schema.js";
import { schemaContractFor, projectDisplayName } from "./subject.js";
import { labelsIntersect } from "../identity/classification.js";
import type { ColumnSchema } from "./table-schema.js";

export interface CollectionMember {
  tableId: string;
  displayName: string;
  project: string | null;
  projectDisplayName: string | null;
  sourcePath: string;
  columns: ColumnSchema[];
}

export type ExclusionReason = "access" | "schema_contract" | "no_project";

export interface Exclusion {
  displayName: string;
  project: string | null;
  reason: ExclusionReason;
  detail: string;
}

export interface CollectionCoverage {
  collection: string;
  /** Members the caller may query and which conform to the contract. */
  members: CollectionMember[];
  /** Everything left out, and why. Must be reported in the answer. */
  excluded: Exclusion[];
  /** Total active members before any filtering. */
  totalRegistered: number;
  /** True when every registered member is included. */
  complete: boolean;
}

/**
 * Enumerate a collection's members, scoped to what the caller may see.
 *
 * `requireProject` excludes members that declare no project. A cross-PROJECT
 * aggregate cannot attribute a row it cannot attribute to a project, so an
 * unscoped register would silently contribute anonymous rows.
 */
export async function enumerateCollection(
  collection: string,
  callerLabels: string[],
  opts: { requireProject?: boolean } = {},
): Promise<CollectionCoverage> {
  const rows = await db
    .select()
    .from(table_registry)
    .where(
      and(
        eq(table_registry.collection, collection),
        eq(table_registry.status, "active"),
        isNotNull(table_registry.collection),
      ),
    );

  const contract = schemaContractFor(collection);
  const members: CollectionMember[] = [];
  const excluded: Exclusion[] = [];

  for (const row of rows) {
    const labels = (row.access_labels as string[]) ?? [];
    const display = row.display_name;
    const project = row.project;

    // 1. Access. Excluded, and RECORDED - the answer must say so.
    if (!labelsIntersect(labels, callerLabels)) {
      excluded.push({
        displayName: display,
        project,
        reason: "access",
        detail: "The caller's labels do not intersect this member's.",
      });
      continue;
    }

    // 2. Project attribution.
    if (opts.requireProject && !project) {
      excluded.push({
        displayName: display,
        project: null,
        reason: "no_project",
        detail:
          "Declares no project, so its rows cannot be attributed in a cross-project aggregate.",
      });
      continue;
    }

    // 3. Schema contract. A member missing a contract column cannot be unioned.
    const columns = ((row.column_schema as { columns: ColumnSchema[] }).columns ?? []);
    const present = new Set(columns.map((c) => c.sql_name));
    const missing = contract.filter((c) => !present.has(c));
    if (missing.length > 0) {
      excluded.push({
        displayName: display,
        project,
        reason: "schema_contract",
        detail: `Missing required column(s): ${missing.join(", ")}. Cannot be unioned.`,
      });
      continue;
    }

    members.push({
      tableId: row.id,
      displayName: display,
      project,
      projectDisplayName: project ? projectDisplayName(project) : null,
      sourcePath: row.source_path,
      columns,
    });
  }

  return {
    collection,
    members,
    excluded,
    totalRegistered: rows.length,
    complete: excluded.length === 0 && rows.length > 0,
  };
}

/**
 * The coverage sentence the answer MUST carry.
 *
 * If the caller can see seven registers of nine, "here are the common issues"
 * is false. The honest claim names its scope. This is rendered into the prompt
 * as EXACT DATA, and the cross-project rubric has a must-pass criterion that
 * the document reports it - a check the enumeration step can make
 * deterministically, because it knows the coverage.
 */
export function renderCoverage(cov: CollectionCoverage): string {
  const lines: string[] = [];

  if (cov.members.length === 0) {
    lines.push(`No accessible ${cov.collection} members. Nothing can be aggregated.`);
    return lines.join("\n");
  }

  const names = cov.members
    .map((m) => (m.projectDisplayName ? `${m.displayName} (${m.projectDisplayName})` : m.displayName))
    .join(", ");
  lines.push(
    `Covered ${cov.members.length} of ${cov.totalRegistered} registered ${cov.collection}(s): ${names}.`,
  );

  if (cov.excluded.length > 0) {
    lines.push(`Excluded ${cov.excluded.length}:`);
    for (const e of cov.excluded) {
      // Name the DOCUMENT, not just its project. A project may have more than
      // one register - one conforming, one legacy - and reporting only the
      // project would list "Project Summit" as both covered and excluded,
      // leaving a reviewer unable to tell which document was left out.
      const where = e.project ? ` (${projectDisplayName(e.project)})` : "";
      lines.push(`  - ${e.displayName}${where}: ${e.detail}`);
    }
    lines.push(
      `This aggregate is INCOMPLETE. Any conclusion drawn from it applies only to the covered members.`,
    );
  }

  return lines.join("\n");
}