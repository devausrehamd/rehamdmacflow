// src/api/routes/data.ts
//
// The structured data query API. The LLM (or any client) sends a JSON
// query structure; the server validates it against the table's registered
// schema, builds parameterized SQL, runs it against the READ-ONLY pool,
// and returns rows.
//
// Endpoints:
//   GET  /api/v1/data/tables            - list accessible tables (discovery)
//   GET  /api/v1/data/tables/:id        - get one table's schema + blurb
//   POST /api/v1/data/tables/:id/query  - run a structured query
//
// Safety layers (defense in depth):
//   1. requireAuth + requirePermission - only authenticated users with the
//      right permission reach here
//   2. Tier check - the table's tier must be in the user's accessible tiers
//   3. Schema validation - columns whitelisted against the registry
//   4. Parameterized SQL - values bound, never concatenated
//   5. Read-only pool - the connection cannot mutate even if everything
//      else failed
//   6. Statement timeout - a runaway query can't hang the API

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { ValidationError, NotFoundError, ForbiddenError } from "../errors.js";
import { readonlyPool } from "../../db/client.js";
import { getTableById, listTables } from "../../data/registry.js";
import {
  buildQuery,
  QueryValidationError,
  type QueryRequest,
} from "../../data/query-builder.js";
import type { DataTier } from "../../tiers.js";

export const dataRouter = Router();

// ---- Discovery: list accessible tables ----

dataRouter.get(
  "/api/v1/data/tables",
  requireAuth,
  requirePermission("ask"),
  async (req, res, next) => {
    try {
      const accessible = req.ctx!.user.accessibleTiers;
      const all = await Promise.all(accessible.map((t) => listTables(t)));
      const tables = all.flat().map((t) => ({
        id: t.id,
        display_name: t.displayName,
        tier: t.tier,
        row_count: t.rowCount,
        columns: t.columns.map((c) => ({ name: c.sql_name, type: c.type })),
      }));
      res.json({ tables });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Get one table's schema and blurb ----

dataRouter.get(
  "/api/v1/data/tables/:id",
  requireAuth,
  requirePermission("ask"),
  async (req, res, next) => {
    try {
      const table = await getTableById(req.params.id);
      if (!table) throw new NotFoundError(`Table ${req.params.id} not found`);
      assertTierAccess(req.ctx!.user.accessibleTiers, table.tier);

      res.json({
        id: table.id,
        display_name: table.displayName,
        tier: table.tier,
        row_count: table.rowCount,
        blurb: table.blurb,
        columns: table.columns,
      });
    } catch (err) {
      next(err);
    }
  },
);

// ---- Run a structured query ----

const filterConditionSchema = z.object({
  column: z.string(),
  op: z.enum([
    "eq", "neq", "gt", "gte", "lt", "lte",
    "in", "like", "ilike", "is_null", "is_not_null",
  ]),
  value: z.unknown().optional(),
});

const queryRequestSchema = z.object({
  select: z.array(z.string()).optional(),
  filter: z
    .object({
      op: z.enum(["and", "or"]),
      conditions: z.array(filterConditionSchema),
    })
    .optional(),
  aggregate: z
    .object({
      fn: z.enum(["count", "sum", "avg", "min", "max"]),
      column: z.string().optional(),
    })
    .optional(),
  group_by: z.array(z.string()).optional(),
  order_by: z
    .array(z.object({ column: z.string(), dir: z.enum(["asc", "desc"]).optional() }))
    .optional(),
  limit: z.number().int().positive().optional(),
});

dataRouter.post(
  "/api/v1/data/tables/:id/query",
  requireAuth,
  requirePermission("ask"),
  async (req, res, next) => {
    try {
      const parsed = queryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid query structure", parsed.error.format());
      }

      const table = await getTableById(req.params.id);
      if (!table) throw new NotFoundError(`Table ${req.params.id} not found`);
      assertTierAccess(req.ctx!.user.accessibleTiers, table.tier);

      let built;
      try {
        built = buildQuery(table.physicalName, table.columns, parsed.data as QueryRequest);
      } catch (err) {
        if (err instanceof QueryValidationError) {
          throw new ValidationError(err.message);
        }
        throw err;
      }

      // Execute against the READ-ONLY pool
      const startTime = Date.now();
      const result = await readonlyPool.query(built.sql, built.params);
      const latency = Date.now() - startTime;

      res.json({
        table_id: table.id,
        display_name: table.displayName,
        row_count: result.rowCount,
        rows: result.rows,
        // Echo the SQL that ran, for transparency and audit. The agent and
        // reviewers can see exactly what was executed.
        executed_sql: built.sql,
        latency_ms: latency,
      });
    } catch (err) {
      next(err);
    }
  },
);

function assertTierAccess(accessibleTiers: DataTier[], tableTier: string): void {
  if (!accessibleTiers.includes(tableTier as DataTier)) {
    throw new ForbiddenError(
      `You do not have access to the '${tableTier}' data domain`,
    );
  }
}