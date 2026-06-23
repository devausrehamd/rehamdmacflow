// scripts/smoke-test-dataplane.ts
//
// Verify the data plane works end-to-end before we build anything on top.
// Tests:
//   1. Config loads and validates
//   2. Tier/role lookups return expected values
//   3. RequestContext builds correctly
//   4. Service factory returns Qdrant + Redis clients
//   5. Qdrant is reachable through the factory
//   6. Redis is reachable through the factory
//   7. QueryRecord round-trips through Redis
//   8. Postgres is reachable
//   9. Drizzle queries work
//
// Usage:
//   npm run smoke:dataplane

import { config } from "../src/config.js";
import { ROLES, TIERS, hasPermission, accessibleTiersFor } from "../src/tiers.js";
import { buildSystemContext, buildServiceContext } from "../src/context.js";
import { getDefaultServices, getAccessibleServices, closeAllServices } from "../src/services.js";
import { QueryRecord } from "../src/queries.js";
import { db, checkDbConnection, closeDb } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { sql } from "drizzle-orm";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

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

async function main(): Promise<void> {
  console.log("=== Data plane smoke test ===\n");

  await step("Config: loads and validates", () => {
    if (!config.qdrant.operations.url) throw new Error("qdrant.operations.url missing");
    if (!config.postgres.database) throw new Error("postgres.database missing");
    if (!config.api.jwtSecret) throw new Error("api.jwtSecret missing");
  });

  await step("Tiers: 'operations' tier defined", () => {
    if (!TIERS.operations) throw new Error("'operations' tier not defined");
    if (!TIERS.operations.qdrantUrl()) throw new Error("qdrant url accessor returned empty");
  });

  await step("Roles: 'engineer' role exists with expected permissions", () => {
    const r = ROLES.engineer;
    if (!r) throw new Error("engineer role missing");
    if (!hasPermission("engineer", "ask")) throw new Error("engineer should have 'ask'");
    if (hasPermission("engineer", "draft:approve")) throw new Error("engineer should NOT have 'draft:approve'");
  });

  await step("Roles: 'admin' has wildcard permissions", () => {
    if (!hasPermission("admin", "anything")) throw new Error("admin should match wildcard");
  });

  await step("Tiers: accessibleTiersFor returns operations for all v1 roles", () => {
    for (const role of ["engineer", "reviewer", "admin", "service"] as const) {
      const tiers = accessibleTiersFor(role);
      if (tiers.length !== 1 || tiers[0] !== "operations") {
        throw new Error(`${role} should have [operations], got ${JSON.stringify(tiers)}`);
      }
    }
  });

  await step("Context: buildSystemContext returns valid context", () => {
    const ctx = buildSystemContext();
    if (!ctx.requestId.startsWith("req_")) throw new Error("requestId not generated");
    if (ctx.user.role !== "admin") throw new Error("system context should be admin");
    if (ctx.user.tier !== "operations") throw new Error("tier should be operations");
  });

  await step("Context: buildServiceContext is constrained to service role", () => {
    const ctx = buildServiceContext();
    if (ctx.user.role !== "service") throw new Error("service context should be 'service' role");
    if (hasPermission(ctx.user.role, "draft:approve")) {
      throw new Error("service role must NOT have 'draft:approve'");
    }
  });

  const ctx = buildSystemContext();
  let qdrantAvailable = false;
  let redisAvailable = false;

  await step("Services: getDefaultServices returns clients", () => {
    const svc = getDefaultServices(ctx);
    if (!svc.qdrant) throw new Error("qdrant client missing");
    if (!svc.redis) throw new Error("redis client missing");
    if (!svc.qdrantCollection) throw new Error("qdrantCollection missing");
  });

  await step("Services: Qdrant reachable", async () => {
    const svc = getDefaultServices(ctx);
    const collections = await svc.qdrant.getCollections();
    if (!Array.isArray(collections.collections)) {
      throw new Error("getCollections returned unexpected shape");
    }
    qdrantAvailable = true;
  });

  await step("Services: Redis reachable", async () => {
    const svc = getDefaultServices(ctx);
    const pong = await svc.redis.ping();
    if (pong !== "PONG") throw new Error(`expected PONG, got ${pong}`);
    redisAvailable = true;
  });

  await step("Services: getAccessibleServices returns one entry for operations", () => {
    const svcs = getAccessibleServices(ctx);
    if (svcs.size !== 1) throw new Error(`expected 1 tier, got ${svcs.size}`);
    if (!svcs.has("operations")) throw new Error("operations tier missing");
  });

  if (redisAvailable) {
    let queryId: string | null = null;

    await step("QueryRecord: create persists to Redis", async () => {
      const q = await QueryRecord.create(ctx, {
        kind: "ask",
        question: "smoke test question",
      });
      if (!q.id.startsWith("qry_")) throw new Error("id format wrong");
      queryId = q.id;
    });

    await step("QueryRecord: load round-trips", async () => {
      if (!queryId) throw new Error("no queryId from previous step");
      const q = await QueryRecord.load(ctx, queryId);
      if (!q) throw new Error("could not load query");
      if (q.question !== "smoke test question") throw new Error("question did not round-trip");
      if (q.status !== "created") throw new Error("status not 'created'");
    });

    await step("QueryRecord: mutations persist", async () => {
      if (!queryId) throw new Error("no queryId");
      const q = await QueryRecord.load(ctx, queryId);
      if (!q) throw new Error("could not reload");
      await q.setTierChunks("operations", [
        { id: "test", text: "fake chunk", score: 0.5 },
      ], 42);
      await q.setStatus("retrieving");

      const reloaded = await QueryRecord.load(ctx, queryId);
      if (!reloaded) throw new Error("could not re-reload");
      if (reloaded.status !== "retrieving") throw new Error("status mutation lost");
      const tier = reloaded.getTierResult("operations");
      if (!tier || tier.chunks.length !== 1) throw new Error("chunks mutation lost");
    });

    await step("QueryRecord: cleanup test record", async () => {
      if (!queryId) return;
      const svc = getDefaultServices(ctx);
      await svc.redis.del(`qms:queries:${queryId}`);
    });
  }

  await step("Postgres: connection reachable", async () => {
    const ok = await checkDbConnection();
    if (!ok) throw new Error("Postgres health check failed");
  });

  await step("Postgres: users table exists and is queryable", async () => {
    // count rows - works even if table is empty
    const result = await db.execute(sql`SELECT COUNT(*) AS n FROM users`);
    const count = Number((result.rows[0] as { n: string }).n);
    if (Number.isNaN(count)) throw new Error("count not a number");
  });

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}All data plane checks passed.${NC}`);
  } else {
    console.log(`${RED}${failed} check(s) failed.${NC}`);
  }

  await closeAllServices();
  await closeDb();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Smoke test crashed:", err);
  await closeAllServices().catch(() => {});
  await closeDb().catch(() => {});
  process.exit(1);
});