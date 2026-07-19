// scripts/smoke-test-agent.ts
//
// Verify the agent graph executes end-to-end without going through HTTP.
// Useful for debugging agent logic separately from API plumbing.
//
// Runs the agent with a system context against a sample question, and logs into
// the ID Server first so a real bearer token is threaded into the graph state.
// Without a token the SQL-retrieval node degrades to vector-only ("no auth token
// in state, skipping SQL retrieval"); logging in exercises the full hybrid path.
// Prints each node's completion in order, then displays the final answer.
//
// Needs the ID Server running (:3001) with the login user in its directory.
//
// Usage:
//   npm run integration:agent
//   npm run integration:agent -- "what does the SDP need to include for Class B"

import { buildSystemContext } from "../src/context.js";
import { QueryRecord } from "../src/queries.js";
import { agent } from "../src/agent/graph.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";
import { buildTraceConfig, flushLangfuse } from "../src/observability/langfuse.js";
import { idServerLogin, IDSERVER_URL } from "./_login.js";

const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

// The stack's auth server is the ID Server; the Agent trusts the tokens it signs
// and resolves entitlements from it. Log in there to get the same bearer token
// an HTTP /ask request would carry. Overridable for a different subject.
const LOGIN_USER = process.env.QMS_SMOKE_USER ?? "dmaher";
const LOGIN_PASS = process.env.QMS_SMOKE_PASSWORD ?? "thisisatest";

async function main(): Promise<void> {
  const question =
    process.argv.slice(2).join(" ").trim() ||
    "What are the columns in the risk register?";

  console.log("=== Agent smoke test ===\n");
  console.log(`Question: ${question}\n`);

  const ctx = buildSystemContext();

  console.log(`Logging in as '${LOGIN_USER}' at ${IDSERVER_URL} ...`);
  const authToken = await idServerLogin(LOGIN_USER, LOGIN_PASS);
  console.log("  got bearer token\n");

  console.log("Creating QueryRecord...");
  const query = await QueryRecord.create(ctx, { kind: "ask", question });
  console.log(`  ID: ${query.id}\n`);

  console.log("Running agent graph:");
  const startTime = Date.now();
  const nodeTimes: Record<string, number> = {};
  let lastNodeTime = startTime;

  try {
    for await (const event of await agent.stream(
      {
        queryId: query.id,
        ctx,
        question,
        authToken,
      },
      buildTraceConfig({
        queryId: query.id,
        userId: ctx.user.id,
        tier: ctx.user.tier,
        kind: "ask-smoke",
      }),
    )) {
      for (const nodeName of Object.keys(event)) {
        const now = Date.now();
        const nodeLatency = now - lastNodeTime;
        nodeTimes[nodeName] = nodeLatency;
        lastNodeTime = now;
        console.log(
          `  ${GREEN}OK${NC}   ${nodeName.padEnd(12)} (${nodeLatency}ms)`,
        );
      }
    }

    const totalElapsed = Date.now() - startTime;
    console.log(`\nTotal: ${(totalElapsed / 1000).toFixed(1)}s\n`);

    // Load and display the final result
    const finalQuery = await QueryRecord.load(ctx, query.id);
    if (!finalQuery) {
      console.error(`${RED}FAIL${NC} QueryRecord disappeared`);
      process.exit(1);
    }

    const data = finalQuery.toJSON();

    console.log("--- Final Answer ---");
    console.log(data.final_answer ?? "(no answer)");
    console.log("--------------------\n");

    console.log("Tier breakdown:");
    for (const [tier, result] of Object.entries(data.tiers)) {
      console.log(
        `  ${tier}: ${result.chunks.length} chunks retrieved, partial ${result.partial_answer?.length ?? 0} chars`,
      );
    }

    console.log(`\n${GREEN}Agent execution complete.${NC}`);
    console.log(`\nInspect the full QueryRecord:`);
    console.log(`  redis-cli get qms:queries:${query.id} | jq`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n${RED}FAIL${NC} Agent execution failed after ${elapsed}s`);
    console.error(err instanceof Error ? err.message : err);
    if (err instanceof Error && err.stack) {
      console.error(`\n${YELLOW}Stack:${NC}\n${err.stack}`);
    }
    process.exit(1);
  } finally {
    await flushLangfuse();
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
  }
}

main()
  // Exit promptly on success - otherwise a lingering trace-flush / client handle
  // can keep the process alive long after the run has finished.
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("Crashed:", err);
    await closeAllServices().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(1);
  });