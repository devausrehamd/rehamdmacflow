// src/data/vector-client.ts
//
// The vector-search Data Access API client (decision-13 refactor R3). This is
// what the agent's retrieval node uses to search the vector store: an HTTP client
// with a bearer token and NO Qdrant client. The authorisation filter is applied
// server-side from the token, so this client carries only a tier name and a query
// vector — it cannot widen its own access.
//
// The prose lane calls this once per query vector and fuses; the table lane calls
// it once with tableOnly. Fusion stays here (it is pure ranking, not data access).

import { config } from "../config.js";

function baseUrl(): string {
  return process.env.QMS_API_INTERNAL_URL ?? `http://localhost:${config.api.port}`;
}

/** A single vector-store hit, as returned by the API: id + score + payload. The
 *  payload shape is the caller's concern (retrieve.ts maps it to a chunk). */
export interface VectorHit {
  id: string | number;
  score?: number;
  payload?: Record<string, unknown> | null;
}

export interface VectorSearchRequest {
  /** The data tier (collection) to search. The server rejects a tier the caller
   *  cannot access. */
  tier: string;
  vector: number[];
  limit: number;
  /** Restrict to points that carry a structured table (the table lane). */
  tableOnly?: boolean;
}

export class VectorApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "VectorApiError";
  }
}

export interface VectorApi {
  search(req: VectorSearchRequest): Promise<VectorHit[]>;
}

/** Build a vector-search client bound to a base URL and a caller bearer token. */
export function vectorApi(url: string, token: string): VectorApi {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  return {
    async search(req) {
      const res = await fetch(`${url}/api/v1/data/vector-search`, {
        method: "POST",
        headers,
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new VectorApiError(res.status, `vector search failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { hits: VectorHit[] };
      return body.hits;
    },
  };
}

/** A vector client against the co-located Data Access API, bound to the caller's
 *  token. This is what the retrieval node uses. */
export function vectorClient(token: string): VectorApi {
  return vectorApi(baseUrl(), token);
}
