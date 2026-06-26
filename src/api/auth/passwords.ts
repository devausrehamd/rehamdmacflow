// src/api/auth/passwords.ts
//
// Password hashing via bcrypt. Wraps the library so handler code never
// imports bcrypt directly - swapping to argon2 or scrypt later is a
// one-file change.
//
// Cost factor 12 is current good default for bcrypt. Higher costs slow
// down brute-force at the expense of legitimate login latency.
// 12 produces ~200ms hash time on M-series Macs.
//
// Password policy: minimum 12 characters. Length is the single best
// predictor of resistance to brute-force; complexity rules ("must have
// uppercase, number, symbol") push users toward password reuse and
// have been deprecated by modern guidance (NIST SP 800-63B).

import bcrypt from "bcrypt";

const BCRYPT_COST = 12;
export const MIN_PASSWORD_LENGTH = 12;

export async function hashPassword(plain: string): Promise<string> {
  const policy = validatePasswordPolicy(plain);
  if (!policy.valid) {
    throw new Error(policy.reason);
  }
  return bcrypt.hash(plain, BCRYPT_COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface PolicyResult {
  valid: boolean;
  reason?: string;
}

export function validatePasswordPolicy(plain: string): PolicyResult {
  if (typeof plain !== "string") {
    return { valid: false, reason: "Password must be a string" };
  }
  if (plain.length < MIN_PASSWORD_LENGTH) {
    return {
      valid: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  return { valid: true };
}