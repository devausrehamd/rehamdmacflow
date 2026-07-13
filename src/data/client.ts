// src/data/client.ts
//
// Internal HTTP client for the data query API. The agent uses this to query
// structured tables - it goes through the real API endpoint (not in-process
// shortcuts), so every query passes the full middleware stack: auth, tier
// check, schema validation, read-only pool, audit logging.
//
// Why HTTP and not a direct function call: maximal boundary enforcement. The
// agent is treated exactly like any external caller. A prompt-injected agent
// cannot exceed the permissions encoded in the token it carries, and every
// query it makes is audit-logged identically to a user's direct query.
//
// The base URL defaults to the local API (the agent runs inside the same
// server process, so this is a localhost self-call). Overridable via
// QMS_API_INTERNAL_URL for tests that run the agent against a test server.

import { config } from "../config.js";
import type { ColumnSchema } from "./table-schema.js";
import type { QueryRequest } from "./query-builder.js";

function baseUrl(): string {
  return process.env.QMS_API_INTERNAL_URL ?? `http://localhost:${config.api.port}`;
}

export interface DataApiTableSummary {
  id: string;
  display_name: string;
  tier: string;
  row_count: number;
  columns: { name: string; type: string }[];
}

export interface DataApiTableDetail {
  id: string;
  display_name: string;
  tier: string;
  row_count: number;
  blurb: string;
  columns: ColumnSchema[];
}

export interface DataApiQueryResult {
  table_id: string;
  display_name: string;
  row_count: number;
  rows: Record<string, unknown>[];
  executed_sql: string;
  latency_ms: number;
}

/** A failed query carries the API's error message so the planner can retry. */
export class DataApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DataApiError";
  }
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = `Data API ${method} ${path} failed with ${res.status}`;
    try {
      const errBody = (await res.json()) as { message?: string };
      if (errBody.message) message = errBody.message;
    } catch {
      // non-JSON error body - keep the generic message
    }
    throw new DataApiError(res.status, message);
  }

  return (await res.json()) as T;
}

export function listTables(token: string): Promise<{ tables: DataApiTableSummary[] }> {
  return call("GET", "/api/v1/data/tables", token);
}

export function getTable(token: string, id: string): Promise<DataApiTableDetail> {
  return call("GET", `/api/v1/data/tables/${id}`, token);
}

export function queryTable(
  token: string,
  id: string,
  query: QueryRequest,
): Promise<DataApiQueryResult> {
  return call("POST", `/api/v1/data/tables/${id}/query`, token, query);
}