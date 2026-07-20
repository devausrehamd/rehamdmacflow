// src/data/query-record-client.ts
//
// The query-record Data Access API client (decision-13 refactor R4). QueryRecord
// (the per-request run state) uses this to load and save itself through the API
// instead of holding a Redis client. An HTTP client with a bearer token and NO
// database access — the last direct store client the agent role held.
//
// The record is an opaque JSON blob here; QueryRecord owns its shape.

import { config } from "../config.js";

function baseUrl(): string {
  return process.env.QMS_API_INTERNAL_URL ?? `http://localhost:${config.api.port}`;
}

export class QueryRecordApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "QueryRecordApiError";
  }
}

export interface QueryRecordApi {
  get<T = unknown>(id: string): Promise<T | null>;
  put(id: string, data: unknown, ttlSeconds: number): Promise<void>;
}

/** Build a query-record client bound to a base URL and a caller bearer token. */
export function queryRecordApi(url: string, token: string): QueryRecordApi {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return {
    async get<T = unknown>(id: string): Promise<T | null> {
      const res = await fetch(`${url}/api/v1/data/query-records/${id}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new QueryRecordApiError(res.status, `get query record failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: T };
      return body.data;
    },
    async put(id, data, ttlSeconds) {
      const res = await fetch(`${url}/api/v1/data/query-records/${id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ data, ttlSeconds }),
      });
      if (!res.ok) throw new QueryRecordApiError(res.status, `put query record failed: ${res.status} ${await res.text()}`);
    },
  };
}

/** A query-record client against the co-located Data Access API, bound to a
 *  token. This is what QueryRecord uses. */
export function queryRecordClient(token: string): QueryRecordApi {
  return queryRecordApi(baseUrl(), token);
}
