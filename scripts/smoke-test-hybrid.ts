// scripts/smoke-test-hybrid.ts
//
// End-to-end test of hybrid retrieval. Because the agent queries SQL through
// the real HTTP data API, this test:
//   1. Loads a synthetic risk-register table into SQL + embeds its blurb
//   2. Starts the API server in-process on a test port
//   3. Creates a temporary user and logs in to get a token
//   4. Runs the agent (via the graph) with a SQL-requiring question
//   5. Verifies the SQL retrieval node fired and exact data reached the answer
//   6. Cleans up table, user, and Qdrant blurb
//
// Usage:
//   npm run integration:hybrid
//
// Requires the full stack running (Ollama, Qdrant, Redis, Postgres).

// IMPORTANT: this import must come FIRST - it sets the isolated test
// collection in env before config is loaded by any subsequent import.
import { TEST_COLLECTION } from "./_hybrid-test-env.js";

import { eq } from "drizzle-orm";
import { db, pool, closeDb } from "../src/db/client.js";
import { table_registry, users } from "../src/db/schema.js";
import { loadTable, physicalTableName, type ExtractedTable } from "../src/data/table-loader.js";
import { createServer } from "../src/api/server.js";
import { buildContext } from "../src/context.js";
import { QueryRecord } from "../src/queries.js";
import { agent } from "../src/agent/graph.js";
import { getTierServices, closeAllServices } from "../src/services.js";
import { QdrantWriter } from "../src/ingestion/qdrant-writer.js";
import { config } from "../src/config.js";
import { buildTraceConfig, flushLangfuse } from "../src/observability/langfuse.js";
import type { Server } from "node:http";
import { idServerLogin } from "./_login.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";
const TEST_PORT = 4999;
let failed = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`${GREEN}OK${NC}   ${name}`);
  } catch (err) {
    failed++;
    console.error(`${RED}FAIL${NC} ${name}`);
    console.error(`     ${err instanceof Error ? err.message : err}`);
  }
}

const sampleTable: ExtractedTable = {
  sourcePath: "__smoke_hybrid__/Risk_Register.xlsx",
  sourceSha256: "hybrid000000000000000000000000000000000000000000000000000000test",
  sheetName: "Risk Register",
  tableIndex: 0,
  displayName: "Hybrid Test Risk Register",
  tier: "operations",
  headers: ["Risk ID", "Title", "Owner", "Status", "Score"],
  rows: [
    ["R-001", "Database failover gap", "A. Singh", "Open", "20"],
    ["R-002", "Supply chain delay", "M. Patel", "Open", "12"],
    ["R-003", "Thermal margin", "T. Chen", "Closed", "6"],
    ["R-004", "EMC compliance", "A. Singh", "Open", "15"],
    ["R-005", "Firmware regression", "M. Patel", "Closed", "4"],
  ],
};

async function main(): Promise<void> {
  console.log("=== Hybrid retrieval smoke test ===\n");

  const testEmail = `hybrid-test-${Date.now()}@qms-agent.test`;
  let server: Server | null = null;
  let tableId: string | null = null;
  let userId: string | null = null;
  let accessToken: string | null = null;

  // Point the agent's data client at the test server
  process.env.QMS_API_INTERNAL_URL = `http://localhost:${TEST_PORT}`;

  try {
    // 1. Load the table and embed its blurb into the ISOLATED test collection
    //    (set in _hybrid-test-env.ts before config loaded, so the agent's
    //    retrieve node already points here). The blurb is the only point, so
    //    retrieval is deterministic - this tests the hybrid mechanism, not
    //    vector ranking against the full corpus.
    await step("Setup: load table + embed blurb", async () => {
      const loaded = await loadTable(sampleTable);
      tableId = loaded.tableId;

      const services = getTierServices("operations");
      // Sanity: config should have resolved to the isolated collection
      if (services.qdrantCollection !== TEST_COLLECTION) {
        throw new Error(
          `agent collection ${services.qdrantCollection} != test collection ${TEST_COLLECTION} - override didn't take`,
        );
      }

      const writer = new QdrantWriter(services.qdrant, {
        collection: TEST_COLLECTION,
        recreateOnIngest: true,
      });
      await writer.ensureCollection();
      await writer.writeTableBlurb({
        tableId: loaded.tableId,
        blurb: loaded.blurb,
        sourcePath: sampleTable.sourcePath,
        sourceSha: sampleTable.sourceSha256,
        displayName: loaded.displayName,
        tier: "operations",
      });

      let count = 0;
      for (let attempt = 0; attempt < 10; attempt++) {
        const c = await services.qdrant.count(TEST_COLLECTION, { exact: true });
        count = c.count;
        if (count > 0) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      console.log(`     [diag] points in isolated test collection: ${count}`);
      if (count === 0) throw new Error("blurb write did not land in Qdrant");
    });

    // 2. Start the API server in-process
    await step("Setup: start API server on test port", async () => {
      const app = createServer();
      await new Promise<void>((resolve) => {
        server = app.listen(TEST_PORT, () => resolve());
      });
    });

    // 3. Log into the ID Server (the stack's auth server) as an engineering
    //    user. The Agent trusts the token and resolves entitlements from the ID
    //    Server, so the SQL path runs against real, granted access.
    await step(`Setup: log in as '${LOGIN_USER}'`, async () => {
      accessToken = await idServerLogin(LOGIN_USER, LOGIN_PASS);
      if (!accessToken) throw new Error("no access token from login");
    });

    // 4. Run the agent with a SQL-requiring question
    let finalAnswer = "";
    let sqlQueryCount = 0;
    await step("Agent: run with a count question", async () => {
      const ctx = buildContext({ id: LOGIN_USER, email: `${LOGIN_USER}@rehamd.local`, role: "admin" });
      const query = await QueryRecord.create(ctx, {
        kind: "ask",
        question: "How many open risks does A. Singh own?",
      });

      for await (const _event of await agent.stream(
        {
          queryId: query.id,
          ctx,
          question: "How many open risks does A. Singh own?",
          authToken: accessToken!,
        },
        buildTraceConfig({
          queryId: query.id,
          userId: ctx.user.id,
          tier: ctx.user.tier,
          kind: "hybrid-smoke",
        }),
      )) {
        // drain the stream
      }

      const finalQuery = await QueryRecord.load(ctx, query.id);
      finalAnswer = finalQuery?.toJSON().final_answer ?? "";

      // --- Diagnostics: where did the hybrid path go? ---
      const record = finalQuery?.toJSON();
      const chunks = Object.values(record?.tiers ?? {}).flatMap((t) => t.chunks);
      const blurbChunks = chunks.filter((c) => c.has_structured_table === true);
      console.log(`\n     [diag] chunks retrieved: ${chunks.length}`);
      console.log(`     [diag] of which table-blurbs: ${blurbChunks.length}`);
      if (blurbChunks.length > 0) {
        console.log(`     [diag] blurb table_id(s): ${blurbChunks.map((c) => c.table_id).join(", ")}`);
      }
      const sqlResults = record?.sql_results ?? [];
      sqlQueryCount = sqlResults.length;
      console.log(`     [diag] SQL queries run: ${sqlResults.length}`);
      for (const r of sqlResults) {
        console.log(`     [diag]   ${r.executed_sql} -> ${r.row_count} row(s)`);
      }

      if (!finalAnswer) throw new Error("no final answer produced");
      console.log(`\n     Answer: ${finalAnswer.replace(/\n/g, " ").slice(0, 200)}\n`);
    });

    // 5. Verify the SQL path actually executed - not just that the text
    //    happens to contain a digit. A passing test MUST mean a SQL query ran.
    await step("Verify: a SQL query actually executed", async () => {
      if (sqlQueryCount === 0) {
        throw new Error(
          "No SQL query ran (SQL queries run: 0). The hybrid path did not " +
            "complete - the planner or gate failed. Answer was: " +
            finalAnswer.slice(0, 200),
        );
      }
    });

    // 6. Verify the answer reflects the exact count (2 open risks for A. Singh)
    await step("Verify: answer contains the exact count", async () => {
      if (!/\b2\b|\btwo\b/i.test(finalAnswer)) {
        throw new Error(
          `Expected the answer to contain the exact count (2). Got: ${finalAnswer.slice(0, 200)}`,
        );
      }
    });
  } finally {
    // Cleanup
    console.log("\nCleaning up...");
    if (tableId) {
      const phys = physicalTableName(tableId);
      await pool.query(`DROP TABLE IF EXISTS "${phys}"`).catch(() => {});
      await db.delete(table_registry).where(eq(table_registry.id, tableId)).catch(() => {});
    }
    if (userId) {
      await db.delete(users).where(eq(users.id, userId)).catch(() => {});
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    // Drop the isolated test collection
    try {
      const services = getTierServices("operations");
      await services.qdrant.deleteCollection(TEST_COLLECTION);
    } catch {
      // best effort
    }
    await flushLangfuse();
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}Hybrid retrieval working - exact data reached the answer.${NC}`);
  } else {
    console.log(`${RED}${failed} check(s) failed.${NC}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});