// scripts/smoke-test-auth.ts
//
// Verifies the auth layer works end-to-end before we build agent endpoints
// on top of it. Tests:
//   1. Password hashing and verification
//   2. Password policy enforcement
//   3. JWT signing and verification
//   4. JWT rejects invalid tokens
//   5. User CRUD (create, find by email, find by id)
//   6. Refresh token storage, lookup, revocation
//   7. Bulk user-token revocation
//
// Uses unique test data each run (timestamped email) so the test is
// repeatable without manual cleanup. Test users are cleaned up at the
// end of each successful run.
//
// Usage:
//   npm run smoke:auth

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import { closeDb } from "../src/db/client.js";
import { closeAllServices } from "../src/services.js";

import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  MIN_PASSWORD_LENGTH,
} from "../src/api/auth/passwords.js";
import {
  signAccessToken,
  verifyAccessToken,
  generateRefreshToken,
} from "../src/api/auth/jwt.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  storeRefreshToken,
  findRefreshTokenUserId,
  revokeRefreshToken,
  revokeAllUserTokens,
} from "../src/api/auth/store.js";
import { AuthError } from "../src/api/errors.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

let failed = 0;
const testEmails: string[] = [];

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

async function cleanup(): Promise<void> {
  if (testEmails.length > 0) {
    for (const email of testEmails) {
      await db.delete(users).where(eq(users.email, email)).catch(() => {});
    }
  }
  await closeDb().catch(() => {});
  await closeAllServices().catch(() => {});
}

async function main(): Promise<void> {
  console.log("=== Auth smoke test ===\n");

  const testTimestamp = Date.now();
  const testEmail = `smoke-test-${testTimestamp}@qms-agent.test`;
  const testPassword = "this-is-a-long-test-password-123";
  let testUserId: string | null = null;

  // ----- Passwords -----

  await step("Passwords: policy rejects short password", () => {
    const result = validatePasswordPolicy("short");
    if (result.valid) throw new Error("short password should be rejected");
    if (!result.reason?.includes(String(MIN_PASSWORD_LENGTH))) {
      throw new Error("reason should mention minimum length");
    }
  });

  await step("Passwords: policy accepts long password", () => {
    const result = validatePasswordPolicy(testPassword);
    if (!result.valid) throw new Error("valid password should be accepted");
  });

  await step("Passwords: hashing produces bcrypt format", async () => {
    const hash = await hashPassword(testPassword);
    if (!hash.startsWith("$2")) throw new Error(`hash should start with $2, got: ${hash.slice(0, 10)}`);
    if (hash.length < 50) throw new Error("hash suspiciously short");
  });

  await step("Passwords: verification round-trips", async () => {
    const hash = await hashPassword(testPassword);
    const ok = await verifyPassword(testPassword, hash);
    if (!ok) throw new Error("correct password failed verification");
  });

  await step("Passwords: verification rejects wrong password", async () => {
    const hash = await hashPassword(testPassword);
    const ok = await verifyPassword("wrong-password-of-sufficient-length", hash);
    if (ok) throw new Error("wrong password should fail verification");
  });

  await step("Passwords: hashing rejects short password", async () => {
    try {
      await hashPassword("short");
      throw new Error("hashing short password should throw");
    } catch (err) {
      if (!(err instanceof Error)) throw new Error("expected Error");
      if (!err.message.includes(String(MIN_PASSWORD_LENGTH))) {
        throw new Error("error should mention minimum length");
      }
    }
  });

  // ----- JWT -----

  const fakeUser = {
    id: "user_test_123",
    email: "fake@test.local",
    role: "engineer",
  };

  let testToken = "";

  await step("JWT: signs an access token", () => {
    testToken = signAccessToken(fakeUser);
    if (!testToken || testToken.split(".").length !== 3) {
      throw new Error("JWT should have three parts separated by dots");
    }
  });

  await step("JWT: verifies a valid token", () => {
    const payload = verifyAccessToken(testToken);
    if (payload.sub !== fakeUser.id) throw new Error("sub mismatch");
    if (payload.email !== fakeUser.email) throw new Error("email mismatch");
    if (payload.role !== fakeUser.role) throw new Error("role mismatch");
    if (payload.iss !== "qms-agent") throw new Error("issuer mismatch");
  });

  await step("JWT: rejects a malformed token", () => {
    try {
      verifyAccessToken("not.a.valid.token");
      throw new Error("malformed token should be rejected");
    } catch (err) {
      if (!(err instanceof AuthError)) {
        throw new Error(`expected AuthError, got ${err}`);
      }
    }
  });

  await step("JWT: rejects a tampered token", () => {
    const tampered = testToken.slice(0, -10) + "XXXXXXXXXX";
    try {
      verifyAccessToken(tampered);
      throw new Error("tampered token should be rejected");
    } catch (err) {
      if (!(err instanceof AuthError)) {
        throw new Error(`expected AuthError, got ${err}`);
      }
    }
  });

  await step("JWT: generates a refresh token", () => {
    const token = generateRefreshToken();
    if (!token.startsWith("rfsh_")) throw new Error("refresh token should have rfsh_ prefix");
    if (token.length < 64) throw new Error("refresh token suspiciously short");
  });

  await step("JWT: refresh tokens are unique", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    if (a === b) throw new Error("two refresh tokens should differ");
  });

  // ----- User CRUD -----

  await step("Users: create a user", async () => {
    const hash = await hashPassword(testPassword);
    const user = await createUser({
      email: testEmail,
      password_hash: hash,
      role: "engineer",
      display_name: "Smoke Test User",
    });
    testEmails.push(testEmail);
    if (!user.id) throw new Error("user.id missing");
    if (user.email !== testEmail) throw new Error("email mismatch");
    if (user.role !== "engineer") throw new Error("role mismatch");
    testUserId = user.id;
  });

  await step("Users: find by email", async () => {
    const user = await findUserByEmail(testEmail);
    if (!user) throw new Error("user not found by email");
    if (user.id !== testUserId) throw new Error("id mismatch");
  });

  await step("Users: find by id", async () => {
    if (!testUserId) throw new Error("no testUserId from previous step");
    const user = await findUserById(testUserId);
    if (!user) throw new Error("user not found by id");
    if (user.email !== testEmail) throw new Error("email mismatch");
  });

  await step("Users: find non-existent email returns null", async () => {
    const user = await findUserByEmail("does-not-exist@nowhere.local");
    if (user !== null) throw new Error("should return null for missing user");
  });

  // ----- Refresh tokens -----

  if (testUserId) {
    const refresh1 = generateRefreshToken();
    const refresh2 = generateRefreshToken();

    await step("Refresh tokens: store and look up", async () => {
      await storeRefreshToken(testUserId!, refresh1, 60);
      const found = await findRefreshTokenUserId(refresh1);
      if (found !== testUserId) {
        throw new Error(`expected ${testUserId}, got ${found}`);
      }
    });

    await step("Refresh tokens: look up non-existent returns null", async () => {
      const found = await findRefreshTokenUserId("rfsh_does_not_exist");
      if (found !== null) throw new Error("should return null");
    });

    await step("Refresh tokens: revoke single token", async () => {
      await storeRefreshToken(testUserId!, refresh2, 60);
      await revokeRefreshToken(refresh2);
      const found = await findRefreshTokenUserId(refresh2);
      if (found !== null) throw new Error("revoked token should not be found");
    });

    await step("Refresh tokens: revoke all user tokens", async () => {
      const tokenA = generateRefreshToken();
      const tokenB = generateRefreshToken();
      await storeRefreshToken(testUserId!, tokenA, 60);
      await storeRefreshToken(testUserId!, tokenB, 60);

      await revokeAllUserTokens(testUserId!);

      if ((await findRefreshTokenUserId(tokenA)) !== null) {
        throw new Error("tokenA should be revoked");
      }
      if ((await findRefreshTokenUserId(tokenB)) !== null) {
        throw new Error("tokenB should be revoked");
      }
    });
  }

  console.log("");
  if (failed === 0) {
    console.log(`${GREEN}All auth checks passed.${NC}`);
  } else {
    console.log(`${RED}${failed} check(s) failed.${NC}`);
  }

  await cleanup();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Smoke test crashed:", err);
  await cleanup().catch(() => {});
  process.exit(1);
});