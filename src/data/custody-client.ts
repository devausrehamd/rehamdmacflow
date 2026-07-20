// src/data/custody-client.ts
//
// The custody Data Access API client (decision-13 refactor R1). This is what an
// agent-role caller uses to record a custody event: an HTTP client with a bearer
// token, and NO database access. It is the enforcement of "all database access is
// API-mediated" on the caller side — a graph node imports this, never
// src/custody/ledger.ts.
//
// The DB-owning writer (appendEvent, with its per-domain advisory lock and the
// single hash chain) lives behind POST /api/v1/data/custody/events. Routing the
// write through HTTP keeps the boundary real even in-process: the endpoint is the
// one place the caller is authenticated, the event is attributed, and the write
// is audited — and it lets the custody store be relocated or load-balanced later
// without touching a caller.
//
// Only types are shared (erased at runtime via `import type`); no server code or
// DB client crosses the boundary.

import { config } from "../config.js";
import type { CustodyContext, CustodyEventType } from "../custody/ledger.js";

export class CustodyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CustodyApiError";
  }
}

/** The Data Access API base URL. Same resolution as the read data client: the
 *  co-located API in the monolith, an internal address once split out. */
function baseUrl(): string {
  return process.env.QMS_API_INTERNAL_URL ?? `http://localhost:${config.api.port}`;
}

export interface CustodyApi {
  /** Append one event to the custody chain THROUGH the API. Returns the assigned
   *  sequence number and the entry hash, exactly as the ledger writer does. */
  append(
    ctx: CustodyContext,
    eventType: CustodyEventType,
    payload: Record<string, unknown>,
  ): Promise<{ seq: number; entryHash: string }>;
}

/** Build a custody API client bound to a base URL and a caller bearer token. The
 *  token is verified server-side on every call (§6); the authenticated identity,
 *  not the body, is the authority for WHO recorded the event. */
export function custodyApi(url: string, token: string): CustodyApi {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return {
    async append(ctx, eventType, payload) {
      const res = await fetch(`${url}/api/v1/data/custody/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ctx, eventType, payload }),
      });
      if (!res.ok) {
        throw new CustodyApiError(res.status, `custody append failed: ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as { seq: number; entryHash: string };
    },
  };
}

/** Convenience: a custody client against the co-located Data Access API, bound to
 *  the caller's token. This is what a graph node uses. */
export function custodyClient(token: string): CustodyApi {
  return custodyApi(baseUrl(), token);
}
