// src/agent/nodes/sql-retrieve.ts
//
// The hybrid retrieval node. Runs AFTER vector retrieve, BEFORE draft.
//
// Flow:
//   1. Scan the retrieved chunks for table blurbs (has_structured_table)
//   2. If none, pass through unchanged (pure vector path)
//   3. LLM gate: does this question actually need exact data? (shouldQuerySql)
//   4. For each table the gate selected:
//        a. Fetch the table's schema from the data API
//        b. Plan a structured query (LLM)
//        c. Execute via the data API over HTTP
//        d. On validation error, replan once with the error, execute again
//        e. On success, record the result; on repeated failure, skip (prose
//           still answers)
//   5. SQL results go into state for the draft node to use as exact data
//
// Every SQL query goes through the real data API endpoint, authenticated as
// the user, so tier permissions and audit logging apply uniformly.

import { QueryRecord } from "../../queries.js";
import type { AgentStateType, SqlResult } from "../state.js";
import {
  shouldQuerySql,
  planQuery,
  type AvailableTable,
} from "../sql-planner.js";
import { getTable, queryTable, DataApiError } from "../../data/client.js";
import { custodyClient } from "../../data/custody-client.js";
import { checkGrounding, fieldSummary, type GroundingIssue } from "../grounding.js";
import { applicableDerivations, derivationsForTable } from "../derivations.js";

interface BlurbRef {
  tableId: string;
  displayName: string;
  columnSummary: string;
}

/** Pull table-blurb references out of the retrieved chunks. */
function findTableBlurbs(state: AgentStateType): BlurbRef[] {
  const seen = new Map<string, BlurbRef>();
  for (const chunks of Object.values(state.chunksByTier)) {
    for (const chunk of chunks) {
      if (chunk.has_structured_table && typeof chunk.table_id === "string") {
        const id = chunk.table_id;
        if (!seen.has(id)) {
          seen.set(id, {
            tableId: id,
            displayName: String(chunk.table_display_name ?? "table"),
            // The blurb text contains the column listing; we pass a trimmed
            // version to the gate so it can judge relevance
            columnSummary: extractColumnSummary(chunk.text),
          });
        }
      }
    }
  }
  return Array.from(seen.values());
}

/** Pull a short column summary out of a blurb's text for the gate prompt. */
function extractColumnSummary(blurbText: string): string {
  // The blurb lists columns as "  - name (type...): ..." lines. Grab the
  // names and types compactly.
  const lines = blurbText.split("\n").filter((l) => /^\s*-\s+\w+\s*\(/.test(l));
  const cols = lines.map((l) => {
    const m = l.match(/-\s+(\w+)\s*\(([^),]+)/);
    return m ? `${m[1]} (${m[2].trim()})` : null;
  });
  return cols.filter(Boolean).join(", ");
}

export async function sqlRetrieve(state: AgentStateType): Promise<Partial<AgentStateType>> {
  const { ctx, queryId, question, authToken } = state;

  const blurbs = findTableBlurbs(state);
  if (blurbs.length === 0) {
    // No structured tables in the retrieved context - pure vector path
    return {};
  }

  // Without a token the node cannot call the data API. This happens only if
  // the caller forgot to thread the token through; degrade to vector-only.
  if (!authToken) {
    console.warn("sql-retrieve: no auth token in state, skipping SQL retrieval");
    return {};
  }

  const queryRecord = await QueryRecord.load(ctx, queryId);

  // --- Gate: does the question need exact data? ---
  const available: AvailableTable[] = blurbs.map((b) => ({
    tableId: b.tableId,
    displayName: b.displayName,
    columnSummary: b.columnSummary,
  }));

  const gate = await shouldQuerySql(question, available);
  console.log(
    `[sql-retrieve] gate decision: needsSql=${gate.needsSql}, tables=${JSON.stringify(gate.tableIds)}`,
  );
  if (!gate.needsSql) {
    console.log(
      `[sql-retrieve] gate declined - available tables were: ${JSON.stringify(available.map((a) => ({ id: a.tableId, cols: a.columnSummary })))}`,
    );
    return {};
  }

  // --- For each selected table: plan -> ground -> execute -> retry once ---
  const sqlResults: Record<string, SqlResult> = {};
  const groundingIssues: GroundingIssue[] = [];

  for (const tableId of gate.tableIds) {
    try {
      // Fetch the authoritative schema from the data API
      const detail = await getTable(authToken, tableId);

      // QMS-defined terms for this table ("critical" -> score >= 16). Injected
      // into the planner so an interpretive term is decoded from its definition
      // instead of guessed; anything still undefined is caught by the gate below.
      const definitions = applicableDerivations(question, detail.display_name, detail.columns);
      if (definitions.length > 0) {
        console.log(`[sql-retrieve] applying ${definitions.length} defined term(s): ${definitions.map((d) => d.term).join(", ")}`);
      }

      // Plan the query
      const plan = await planQuery(question, detail.columns, definitions);
      let queryReq = plan.query;
      console.log(`[sql-retrieve] planned query for ${tableId}: ${JSON.stringify(queryReq)}`);

      // The decoder abstained on an interpretive term it could not map to a
      // column value or a defined term (increment 3). Its query omits that term,
      // so executing it would silently drop the user's intent — call it out
      // instead, and suggest the terms the QMS does define.
      if (plan.unresolved.length > 0) {
        console.log(`[sql-retrieve] unresolved term(s) for ${tableId}: ${plan.unresolved.map((u) => u.term).join(", ")}`);
        groundingIssues.push({
          tableId,
          displayName: detail.display_name,
          ungrounded: [],
          unresolvedTerms: plan.unresolved,
          availableFields: fieldSummary(detail.columns),
          definedTerms: derivationsForTable(detail.display_name, detail.columns).map((d) => d.term),
        });
        continue;
      }

      // Grounding gate: a filter whose value falls outside its column's domain is
      // a decode failure ("likelihood = 5" when likelihood is 1–4), not a "0
      // results" answer. Refuse to execute it — the graph calls it out rather than
      // guess. Re-checked after any corrective replan below.
      let grounding = checkGrounding(queryReq, detail.columns);

      // Execute, with one corrective retry on validation error
      let result;
      if (grounding.grounded) {
        try {
          result = await queryTable(authToken, tableId, queryReq);
        } catch (err) {
          if (err instanceof DataApiError && err.status === 400) {
            console.log(`[sql-retrieve] query rejected (${err.message}), replanning...`);
            // Replan with the error, try once more
            queryReq = (await planQuery(question, detail.columns, definitions, err.message)).query;
            console.log(`[sql-retrieve] replanned query: ${JSON.stringify(queryReq)}`);
            grounding = checkGrounding(queryReq, detail.columns);
            if (grounding.grounded) result = await queryTable(authToken, tableId, queryReq);
          } else {
            throw err;
          }
        }
      }

      // Ungrounded: record the decode failure and move on — the graph will answer
      // by calling it out rather than reporting a misleading count.
      if (!grounding.grounded) {
        console.log(`[sql-retrieve] ungrounded query for ${tableId}: ${JSON.stringify(grounding.ungrounded)}`);
        groundingIssues.push({
          tableId,
          displayName: detail.display_name,
          ungrounded: grounding.ungrounded,
          availableFields: fieldSummary(detail.columns),
        });
        continue;
      }
      if (!result) continue; // grounded but produced no result (defensive)

      sqlResults[tableId] = {
        tableId,
        displayName: result.display_name,
        executedSql: result.executed_sql,
        rowCount: result.row_count,
        rows: result.rows,
      };
      // Row COUNT only. stdout is not Langfuse: it reaches the terminal,
      // container logs, and CI output - stores with no access list. The full
      // rows belong in the trace span, which is access-controlled.
      console.log(`[sql-retrieve] ${result.row_count} row(s) for ${tableId}`);

      // Persist to the QueryRecord audit artifact (note: authToken is NOT
      // written here - only the query and its results)
      if (queryRecord) {
        await queryRecord.appendSqlResult({
          table_id: tableId,
          display_name: result.display_name,
          executed_sql: result.executed_sql,
          row_count: result.row_count,
        });
      }

      // Custody: record the query SHAPE, the executed SQL, and the row count -
      // never the rows themselves (they may carry PII, and the chain is
      // immutable). This is the "did it query, and get what it claims" evidence.
      // Recorded through the Data Access API (decision 13). authToken is
      // guaranteed here: this node returns early above when it is absent.
      await custodyClient(authToken).append(
        {
          correlationId: ctx.correlationId,
          runId: ctx.runId,
          userId: ctx.user.id,
          decisionId: ctx.decisionId,
          policyHash: ctx.policyHash,
        },
        "sql_query",
        {
          tableId,
          request: queryReq,
          executedSql: result.executed_sql,
          rowCount: result.row_count,
        },
      );
    } catch (err) {
      // This table failed planning or execution - skip it. The prose partial
      // still answers; we just don't have exact data for this one.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`sql-retrieve: table ${tableId} failed: ${message}`);
    }
  }

  return { sqlResults, groundingIssues };
}