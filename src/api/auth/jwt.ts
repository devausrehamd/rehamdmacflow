// src/api/auth/jwt.ts
//
// Access tokens are short-lived JWTs (15 min default) signed with HS256.
// They carry user id, email, and role. Stateless verification means no
// database lookup needed for routine auth checks.
//
// Refresh tokens are deliberately NOT JWTs. They're opaque random strings
// stored in Redis with a TTL. Why: JWTs cannot be revoked; once issued,
// they're valid until expiry. Refresh tokens stored as Redis keys can
// be deleted at any time - on logout, on password change, on session
// rotation - giving us proper session control.

import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { config } from "../../config.js";
import { AuthError } from "../errors.js";

// Issuer stamped on tokens the Agent mints itself (local login).
const LOCAL_ISSUER = "qms-agent";

export interface AccessTokenPayload {
  sub: string;
  // Optional: tokens minted by the external ID Server carry only sub/role.
  email?: string;
  role: string;
  iat: number;
  exp: number;
  iss: string;
}

export function signAccessToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
    },
    config.api.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: `${config.api.accessTokenTtlMinutes}m`,
      issuer: LOCAL_ISSUER,
    },
  );
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    // Accept both the Agent's own issuer and the trusted external ID Server's,
    // so local logins and ID-Server-issued tokens both verify.
    return jwt.verify(token, config.api.jwtSecret, {
      issuer: [LOCAL_ISSUER, config.api.identityIssuer],
      algorithms: ["HS256"],
    }) as AccessTokenPayload;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Token verification failed";
    throw new AuthError(`Invalid or expired token: ${message}`);
  }
}

/** Generate an opaque refresh token. NOT a JWT - just random bytes with a prefix. */
export function generateRefreshToken(): string {
  return `rfsh_${randomBytes(32).toString("hex")}`;
}