// src/api/server.ts
//
// Express application. Wires up middleware in the correct order:
//   1. JSON parser
//   2. Request ID (for log correlation)
//   3. Audit logging (records every request)
//   4. Routes (public health + /api/v1/auth/*)
//   5. 404 handler (catches unmatched routes)
//   6. Error handler (LAST, converts thrown errors to JSON responses)
//
// Auth routes implemented in this batch:
//   POST /api/v1/auth/login    - email + password -> tokens
//   POST /api/v1/auth/refresh  - refresh token -> new tokens (token rotation)
//   POST /api/v1/auth/logout   - revoke all user tokens
//   GET  /api/v1/whoami        - return authenticated user info
//
// Agent endpoints (/ask, /drafts, etc.) come in batch 3.

import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { config } from "../config.js";
import { AuthError, ValidationError, errorHandler } from "./errors.js";
import { signAccessToken, generateRefreshToken } from "./auth/jwt.js";
import { verifyPassword } from "./auth/passwords.js";
import {
  findUserByEmail,
  findUserById,
  storeRefreshToken,
  findRefreshTokenUserId,
  revokeRefreshToken,
  revokeAllUserTokens,
  updateLastLogin,
} from "./auth/store.js";
import { requireAuth } from "./auth/middleware.js";
import { askRouter } from "./routes/ask.js";
import { dataRouter } from "./routes/data.js";

export function createServer() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));

  // Request ID - attach a unique ID to every request for log correlation.
  // Honors incoming X-Request-Id from upstream proxies if present.
  app.use((req, res, next) => {
    const id =
      (req.headers["x-request-id"] as string | undefined) ??
      `req_${randomBytes(8).toString("hex")}`;
    req.requestId = id;
    res.setHeader("x-request-id", id);
    next();
  });

  // Audit logging - one JSON line per request, written after the response
  // is sent. For batch 1 this goes to stdout; in batch 3 we'll write it
  // to the Redis audit stream and archive to Postgres.
  app.use((req, res, next) => {
    const startTime = Date.now();
    res.on("finish", () => {
      const entry = {
        type: "audit",
        timestamp: new Date().toISOString(),
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - startTime,
        user_id: req.ctx?.user.id,
        user_email: req.ctx?.user.email,
        user_role: req.ctx?.user.role,
        ip: req.ip,
        user_agent: req.headers["user-agent"],
      };
      console.log(JSON.stringify(entry));
    });
    next();
  });

  // ----- Health (no auth) -----

  app.get("/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      service: "qms-agent-api",
    });
  });

  // ----- Auth routes -----

  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
  });

  app.post("/api/v1/auth/login", async (req, res, next) => {
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid login payload", parsed.error.format());
      }
      const { email, password } = parsed.data;

      const user = await findUserByEmail(email);
      // Use the same error for missing user and wrong password to avoid
      // exposing whether an email is registered (timing-attack mitigation
      // would be more thorough but this is a reasonable starting point).
      if (!user || !user.is_active) {
        throw new AuthError("Invalid credentials");
      }

      const passwordOk = await verifyPassword(password, user.password_hash);
      if (!passwordOk) {
        throw new AuthError("Invalid credentials");
      }

      // Single-session-per-user: revoke any existing refresh tokens before
      // issuing new ones. This means logging in invalidates other devices.
      await revokeAllUserTokens(user.id);

      const accessToken = signAccessToken({
        id: user.id,
        email: user.email,
        role: user.role,
      });
      const refreshToken = generateRefreshToken();
      const refreshTtlSeconds = config.api.refreshTokenTtlDays * 24 * 60 * 60;
      await storeRefreshToken(user.id, refreshToken, refreshTtlSeconds);

      await updateLastLogin(user.id);

      res.json({
        accessToken,
        refreshToken,
        accessTokenExpiresIn: config.api.accessTokenTtlMinutes * 60,
        refreshTokenExpiresIn: refreshTtlSeconds,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          display_name: user.display_name,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  const refreshSchema = z.object({
    refreshToken: z.string().min(1),
  });

  app.post("/api/v1/auth/refresh", async (req, res, next) => {
    try {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid refresh payload");
      }
      const { refreshToken } = parsed.data;

      const userId = await findRefreshTokenUserId(refreshToken);
      if (!userId) {
        throw new AuthError("Invalid or expired refresh token");
      }

      const user = await findUserById(userId);
      if (!user || !user.is_active) {
        // User was disabled or removed - clean up the dangling token
        await revokeRefreshToken(refreshToken);
        throw new AuthError("User no longer active");
      }

      // Token rotation: invalidate the used refresh token and issue a new
      // one. If a stolen token is used, the legitimate user's refresh will
      // fail next time (because the thief's rotation invalidated theirs).
      await revokeRefreshToken(refreshToken);

      const accessToken = signAccessToken({
        id: user.id,
        email: user.email,
        role: user.role,
      });
      const newRefreshToken = generateRefreshToken();
      const refreshTtlSeconds = config.api.refreshTokenTtlDays * 24 * 60 * 60;
      await storeRefreshToken(user.id, newRefreshToken, refreshTtlSeconds);

      res.json({
        accessToken,
        refreshToken: newRefreshToken,
        accessTokenExpiresIn: config.api.accessTokenTtlMinutes * 60,
        refreshTokenExpiresIn: refreshTtlSeconds,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/v1/auth/logout", requireAuth, async (req, res, next) => {
    try {
      const userId = req.ctx!.user.id;
      await revokeAllUserTokens(userId);
      res.json({ message: "Logged out" });
    } catch (err) {
      next(err);
    }
  });

  app.get("/api/v1/whoami", requireAuth, (req: Request, res: Response) => {
    const user = req.ctx!.user;
    res.json({
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        tier: user.tier,
        accessibleTiers: user.accessibleTiers,
      },
      requestId: req.ctx!.requestId,
    });
  });

  // ----- Agent routes -----

  app.use(askRouter);
  app.use(dataRouter);

  // 404 for unmatched routes
  app.use((req, res) => {
    res.status(404).json({
      error: "NotFound",
      message: `No route for ${req.method} ${req.path}`,
      requestId: req.requestId,
    });
  });

  // Error handler MUST be last
  app.use(errorHandler);

  return app;
}

// Entry point for `npm run api`
if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createServer();
  const port = config.api.port;

  const server = app.listen(port, () => {
    console.log(`QMS Agent API listening on http://localhost:${port}`);
    console.log(`  Health:  GET    http://localhost:${port}/health`);
    console.log(`  Login:   POST   http://localhost:${port}/api/v1/auth/login`);
    console.log(`  Refresh: POST   http://localhost:${port}/api/v1/auth/refresh`);
    console.log(`  Logout:  POST   http://localhost:${port}/api/v1/auth/logout`);
    console.log(`  Whoami:  GET    http://localhost:${port}/api/v1/whoami`);
    console.log(`  Ask:     POST   http://localhost:${port}/api/v1/ask  (SSE stream)`);
  });

  // Graceful shutdown on SIGTERM/SIGINT
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    server.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => {
      console.error("Forcing shutdown");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}