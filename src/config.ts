// src/config.ts
//
// Environment-driven configuration. Single point of process.env access.
// Validated via Zod at startup - missing or malformed values fail fast
// with a clear error.
//
// The shape is tier-aware: qdrant.operations.url, redis.operations.host.
// For v1 with one tier, there's one entry per service. When tiers split,
// add entries for engineering, financial, etc. without changing call sites.
//
// Backward compatibility: old QDRANT_URL and REDIS_HOST env vars are read
// as fallbacks for the new tier-prefixed names, so existing .env files
// keep working.

import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  ollama: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    embedModel: z.string().min(1),
  }),
  qdrant: z.object({
    operations: z.object({
      url: z.string().url(),
      collection: z.string().min(1),
    }),
  }),
  redis: z.object({
    operations: z.object({
      host: z.string().min(1),
      port: z.number().int().positive(),
    }),
  }),
  postgres: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
    user: z.string().min(1),
    password: z.string().min(1),
    database: z.string().min(1),
    // Read-only role for the data query API. Optional - falls back to the
    // read-write credentials with a warning if unset.
    readonlyUser: z.string().optional(),
    readonlyPassword: z.string().optional(),
  }),

  // Observability. All optional - absent keys mean tracing is off and the
  // agent runs identically without it.
  langfuse: z.object({
    publicKey: z.string().optional(),
    secretKey: z.string().optional(),
    baseUrl: z.string().default("http://localhost:3000"),
  }),
  api: z.object({
    port: z.number().int().positive(),
    jwtSecret: z.string().min(32, "JWT secret must be at least 32 characters"),
    accessTokenTtlMinutes: z.number().int().positive().default(15),
    refreshTokenTtlDays: z.number().int().positive().default(7),
  }),
  qmsFolder: z.string().min(1),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const raw = {
    ollama: {
      baseUrl: process.env.OLLAMA_BASE_URL,
      model: process.env.OLLAMA_MODEL,
      embedModel: process.env.OLLAMA_EMBED_MODEL,
    },
    qdrant: {
      operations: {
        // Prefer new tier-prefixed names, fall back to legacy ones.
        // QMS_QDRANT_COLLECTION_OVERRIDE lets tests point the agent at an
        // isolated collection without touching the real one.
        url: process.env.QDRANT_OPERATIONS_URL ?? process.env.QDRANT_URL,
        collection:
          process.env.QMS_QDRANT_COLLECTION_OVERRIDE ??
          process.env.QDRANT_OPERATIONS_COLLECTION ??
          process.env.QDRANT_COLLECTION,
      },
    },
    redis: {
      operations: {
        host: process.env.REDIS_OPERATIONS_HOST ?? process.env.REDIS_HOST,
        port: Number(process.env.REDIS_OPERATIONS_PORT ?? process.env.REDIS_PORT ?? 6379),
      },
    },
    postgres: {
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DATABASE,
      readonlyUser: process.env.POSTGRES_READONLY_USER,
      readonlyPassword: process.env.POSTGRES_READONLY_PASSWORD,
    },
    langfuse: {
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? "http://localhost:3000",
    },
    api: {
      port: Number(process.env.API_PORT ?? 4000),
      jwtSecret: process.env.JWT_SECRET,
      accessTokenTtlMinutes: Number(process.env.ACCESS_TOKEN_TTL_MINUTES ?? 15),
      refreshTokenTtlDays: Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 7),
    },
    qmsFolder: process.env.QMS_FOLDER,
    logLevel: process.env.LOG_LEVEL,
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    console.error("Invalid configuration. Check your .env file:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    throw new Error("Configuration validation failed.");
  }

  return result.data;
}

export const config = loadConfig();