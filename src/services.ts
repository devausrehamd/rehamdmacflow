// src/services.ts
//
// Tier-aware service factory. Replaces direct imports of Qdrant and Redis
// clients from clients.ts.
//
// Today there is one tier so all factory functions return the same clients.
// When tiers split physically, the factory routes connections by tier
// without any caller having to change.
//
// Three accessor patterns:
//   - getTierServices(tier)         : explicit tier, for admin operations
//   - getDefaultServices(ctx)        : user's default tier, for writes
//   - getAccessibleServices(ctx)     : all readable tiers, for multi-tier retrieval

import { QdrantClient } from "@qdrant/js-client-rest";
import Redis from "ioredis";
import type { RequestContext } from "./context.js";
import type { DataTier } from "./tiers.js";
import { TIERS } from "./tiers.js";

export interface TierServices {
  qdrant: QdrantClient;
  redis: Redis;
  /** The collection name for this tier (vector search target) */
  qdrantCollection: string;
}

// Lazy singleton clients per tier. Created on first access, reused thereafter.
// Map (not Record) because the keys are typed and we want explicit Map semantics.
const qdrantByTier = new Map<DataTier, QdrantClient>();
const redisByTier = new Map<DataTier, Redis>();

function getOrCreateQdrant(tier: DataTier): QdrantClient {
  let client = qdrantByTier.get(tier);
  if (!client) {
    client = new QdrantClient({ url: TIERS[tier].qdrantUrl() });
    qdrantByTier.set(tier, client);
  }
  return client;
}

function getOrCreateRedis(tier: DataTier): Redis {
  let client = redisByTier.get(tier);
  if (!client) {
    client = new Redis({
      host: TIERS[tier].redisHost(),
      port: TIERS[tier].redisPort(),
      // Fail fast on bad connections instead of retrying forever.
      // The connection layer still reconnects transparently on transient blips.
      maxRetriesPerRequest: 1,
    });

    // Deduplicate error logs - ioredis fires on every reconnect attempt
    let lastError = "";
    client.on("error", (err) => {
      if (err.message !== lastError) {
        console.error(`Redis error [${tier}]:`, err.message);
        lastError = err.message;
      }
    });

    redisByTier.set(tier, client);
  }
  return client;
}

/** Get services for a specific tier. Used by admin code and the multi-tier retriever. */
export function getTierServices(tier: DataTier): TierServices {
  return {
    qdrant: getOrCreateQdrant(tier),
    redis: getOrCreateRedis(tier),
    qdrantCollection: TIERS[tier].qdrantCollection(),
  };
}

/** Get services for the user's default tier. Common case for writes. */
export function getDefaultServices(ctx: RequestContext): TierServices {
  return getTierServices(ctx.user.tier);
}

/**
 * Get services for every tier the user can read from.
 * Returned as a Map keyed by tier for parallel-retrieval patterns.
 *
 * Usage:
 *   const services = getAccessibleServices(ctx);
 *   const results = await Promise.all(
 *     Array.from(services.entries()).map(async ([tier, svc]) => {
 *       const chunks = await svc.qdrant.search(svc.qdrantCollection, ...);
 *       return [tier, chunks];
 *     })
 *   );
 */
export function getAccessibleServices(ctx: RequestContext): Map<DataTier, TierServices> {
  const result = new Map<DataTier, TierServices>();
  for (const tier of ctx.user.accessibleTiers) {
    result.set(tier, getTierServices(tier));
  }
  return result;
}

/** Cleanly close all open service connections. For shutdown and tests. */
export async function closeAllServices(): Promise<void> {
  await Promise.all([...redisByTier.values()].map((r) => r.quit()));
  redisByTier.clear();
  qdrantByTier.clear();
}