// src/api/auth/store.ts
//
// Bridge between auth code and storage. Two storage layers:
//   - Users: durable, lives in Postgres via Drizzle
//   - Refresh tokens: ephemeral, lives in Redis with TTL
//
// The user functions return Drizzle's inferred types from schema.ts.
// The refresh token functions return primitive values (string | null).

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, type User, type NewUser } from "../../db/schema.js";
import { getTierServices } from "../../services.js";

// ----------------------------------------------------------------------------
// Users (Postgres)
// ----------------------------------------------------------------------------

export async function findUserByEmail(email: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createUser(data: NewUser): Promise<User> {
  const [created] = await db.insert(users).values(data).returning();
  return created;
}

export async function updateLastLogin(id: string): Promise<void> {
  await db
    .update(users)
    .set({ last_login_at: new Date() })
    .where(eq(users.id, id));
}

export async function updateUserPassword(id: string, passwordHash: string): Promise<void> {
  await db
    .update(users)
    .set({ password_hash: passwordHash, updated_at: new Date() })
    .where(eq(users.id, id));
}

// ----------------------------------------------------------------------------
// Refresh tokens (Redis)
//
// Key layout:
//   qms:refresh-tokens:{token}    -> userId  (with TTL)
//   qms:user-tokens:{userId}      -> Set of tokens owned by this user
//
// The set is needed so logout can revoke ALL of a user's tokens by id.
// Single-session-per-user policy means this set typically contains
// at most one entry, but the structure supports multi-session if we
// relax the policy later.
//
// For v1, refresh tokens always live in the operations tier's Redis -
// they're a session concern, not a domain concern, so they don't need
// tier-awareness. When tiers split physically, we'd move sessions to
// a central "governance" or "session" tier.
// ----------------------------------------------------------------------------

const REFRESH_KEY_PREFIX = "qms:refresh-tokens:";
const USER_TOKENS_KEY_PREFIX = "qms:user-tokens:";

function sessionRedis() {
  return getTierServices("operations").redis;
}

export async function storeRefreshToken(
  userId: string,
  token: string,
  ttlSeconds: number,
): Promise<void> {
  const redis = sessionRedis();
  // Track token -> user mapping with TTL for stateless lookup
  await redis.set(`${REFRESH_KEY_PREFIX}${token}`, userId, "EX", ttlSeconds);
  // Track user -> token set for bulk revocation on logout
  await redis.sadd(`${USER_TOKENS_KEY_PREFIX}${userId}`, token);
  await redis.expire(`${USER_TOKENS_KEY_PREFIX}${userId}`, ttlSeconds);
}

export async function findRefreshTokenUserId(token: string): Promise<string | null> {
  const redis = sessionRedis();
  return redis.get(`${REFRESH_KEY_PREFIX}${token}`);
}

export async function revokeRefreshToken(token: string): Promise<void> {
  const redis = sessionRedis();
  const userId = await redis.get(`${REFRESH_KEY_PREFIX}${token}`);
  await redis.del(`${REFRESH_KEY_PREFIX}${token}`);
  if (userId) {
    await redis.srem(`${USER_TOKENS_KEY_PREFIX}${userId}`, token);
  }
}

/** Revoke ALL refresh tokens for a user. Used on login (single-session)
 * and on explicit logout. */
export async function revokeAllUserTokens(userId: string): Promise<void> {
  const redis = sessionRedis();
  const tokens = await redis.smembers(`${USER_TOKENS_KEY_PREFIX}${userId}`);
  if (tokens.length > 0) {
    const keys = tokens.map((t) => `${REFRESH_KEY_PREFIX}${t}`);
    await redis.del(...keys);
  }
  await redis.del(`${USER_TOKENS_KEY_PREFIX}${userId}`);
}