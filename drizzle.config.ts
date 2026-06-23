// drizzle.config.ts
//
// Configuration for drizzle-kit (migration generator and inspector).
//
// Usage:
//   npx drizzle-kit generate    # Generate a migration from schema changes
//   npx drizzle-kit migrate     # Apply pending migrations
//   npx drizzle-kit studio      # Open the schema browser at https://local.drizzle.studio

import { defineConfig } from "drizzle-kit";
import "dotenv/config";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? "qms_agent",
    password: process.env.POSTGRES_PASSWORD ?? "",
    database: process.env.POSTGRES_DATABASE ?? "qms_agent",
    ssl: false,
  },
  verbose: true,
  strict: true,
});