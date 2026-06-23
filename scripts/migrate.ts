// scripts/migrate.ts
//
// Apply pending Postgres migrations.
//
// Usage:
//   npm run db:migrate

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { config } from "../src/config.js";

const { Pool } = pg;

async function main(): Promise<void> {
  console.log("Connecting to Postgres...");
  console.log(`  host: ${config.postgres.host}:${config.postgres.port}`);
  console.log(`  database: ${config.postgres.database}`);
  console.log(`  user: ${config.postgres.user}`);

  const pool = new Pool({
    host: config.postgres.host,
    port: config.postgres.port,
    user: config.postgres.user,
    password: config.postgres.password,
    database: config.postgres.database,
  });

  const db = drizzle(pool);

  console.log("\nApplying migrations from ./drizzle ...");

  try {
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations applied successfully.");
  } catch (err) {
    console.error("\nMigration failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();