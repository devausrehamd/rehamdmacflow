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

const pool = new Pool({
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

export const db = drizzle(pool, { schema });

/** Cleanly close the connection pool. For shutdown. */
export async function closeDb(): Promise<void> {
  await pool.end();
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