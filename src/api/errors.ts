// src/api/errors.ts
//
// Typed errors and the Express error-handler middleware.
//
// Handlers throw a typed error; the middleware converts it to a JSON
// response with the appropriate HTTP status code. This keeps handler
// code focused on the happy path and centralizes error response format.

import type { ErrorRequestHandler } from "express";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }

  toJSON() {
    return {
      error: this.name,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export class AuthError extends HttpError {
  constructor(message = "Authentication required") {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message = "Access denied") {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found") {
    super(404, message);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/**
 * Express error-handler middleware. Must be the LAST middleware in the
 * chain - registered AFTER all routes and other middleware.
 *
 * Converts HttpError instances to their typed status + body. All other
 * errors become a generic 500 with the error message preserved for logs
 * but a safe message returned to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = (req as { requestId?: string }).requestId ?? "unknown";

  if (err instanceof HttpError) {
    // Typed application errors - return as designed
    res.status(err.status).json({
      ...err.toJSON(),
      requestId,
    });
    return;
  }

  // Unknown error - log full details server-side, return safe message
  console.error(`[${requestId}] Unhandled error:`, err);
  res.status(500).json({
    error: "InternalServerError",
    message: "An unexpected error occurred",
    requestId,
  });
};