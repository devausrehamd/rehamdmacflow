// src/config.ts
//
// Environment-driven configuration. The ONLY place in the project that
// reads process.env directly. Everything else imports `config` from here.
//
// Validation via Zod catches missing or malformed values at startup
// rather than at runtime when a query fails for mysterious reasons.

import "dotenv/config";
import { z } from "zod";

const ConfigSchema = z.object({
  ollama: z.object({
    baseUrl: z.string().url(),
    model: z.string().min(1),
    embedModel: z.string().min(1),
  }),
  qdrant: z.object({
    url: z.string().url(),
    collection: z.string().min(1),
  }),
  redis: z.object({
    host: z.string().min(1),
    port: z.number().int().positive(),
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
      url: process.env.QDRANT_URL,
      collection: process.env.QDRANT_COLLECTION,
    },
    redis: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT ?? 6379),
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