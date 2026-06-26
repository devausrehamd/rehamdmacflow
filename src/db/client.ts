// src/db/client.ts
//
// Postgres connection pool and Drizzle ORM client.
//
// The pool is configured once at startup and reused across the application.
// Individual queries borrow connections from the pool, run, and return them.
// 10 max connections is plenty for v1; raise if you see connection pressure
// in pool stats.

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { config } from "../config.js";
import * as schema from "./schema.js";

const { Pool } = pg;

// Read-write pool. Used by migrations, the table loader (CREATE/INSERT/DROP),
// and all normal application writes.
export const pool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.user,
  password: config.postgres.password,
  database: config.postgres.database,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Surface unexpected pool-level errors. These usually mean the database
// went away unexpectedly - the next query will reconnect, but it's good
// to log so the cause isn't a mystery.
pool.on("error", (err) => {
  console.error("Unexpected Postgres pool error:", err.message);
});

// Read-ONLY pool for the data query API. Connects as the qms_readonly role,
// which has only SELECT privileges. This is the connection the agent's data
// retrieval reaches - it is structurally incapable of mutation, so even a
// bug in the query builder or a prompt-injected agent cannot alter data.
//
// Falls back to the read-write credentials if the read-only role isn't
// configured (e.g. early dev before setup creates the role) - but logs a
// warning, because in any real deployment the read-only role must exist.
const readonlyConfigured = Boolean(config.postgres.readonlyUser);
if (!readonlyConfigured) {
  console.warn(
    "POSTGRES_READONLY_USER not set - data API will use the read-write " +
      "connection. Configure the read-only role before relying on isolation.",
  );
}

export const readonlyPool = new Pool({
  host: config.postgres.host,
  port: config.postgres.port,
  user: config.postgres.readonlyUser ?? config.postgres.user,
  password: config.postgres.readonlyPassword ?? config.postgres.password,
  database: config.postgres.database,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // A hard ceiling on query time - a runaway analytic query can't hang the API
  statement_timeout: 10000,
});

readonlyPool.on("error", (err) => {
  console.error("Unexpected read-only Postgres pool error:", err.message);
});

// The Drizzle ORM client, backed by the read-write pool.
export const db = drizzle(pool, { schema });

/** Cleanly close the connection pools. For shutdown. */
export async function closeDb(): Promise<void> {
  await Promise.all([pool.end(), readonlyPool.end()]);
}

/**
 * Health check - returns true if a connection can be obtained and a trivial
 * query succeeds. Useful for startup verification and the /health endpoint.
 */
export async function checkDbConnection(): Promise<boolean> {
  try {
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
      return true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Postgres health check failed:", err);
    return false;
  }
}

// Re-export the schema for convenience
export * as schema from "./schema.js";