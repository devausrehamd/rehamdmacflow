// src/data/artifact-client.ts
//
// The artifact Data Access API client (Stage 0). This is what a caller — an
// agent on its own VM — uses to read and write artifacts: an HTTP client with a
// bearer token, and NO database access. It is the enforcement of the rule "all
// database access is API-mediated" on the caller side: an agent imports this,
// never src/custody/artifacts.ts.
//
// Only the Artifact type is shared (types are erased at runtime); no server code
// or DB client crosses the boundary.

import type { Artifact } from "../custody/artifacts.js";

export class DataAccessError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DataAccessError";
  }
}

export interface ArtifactApi {
  put(artifact: Artifact): Promise<string>;
  get(hash: string): Promise<Artifact | null>;
}

/** Build an artifact API client bound to a Data Access API base URL and a caller
 *  bearer token. The token is verified on every call server-side (§6). */
export function artifactApi(baseUrl: string, token: string): ArtifactApi {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  return {
    async put(artifact) {
      const res = await fetch(`${baseUrl}/api/v1/data/artifacts`, {
        method: "POST",
        headers,
        body: JSON.stringify(artifact),
      });
      if (!res.ok) throw new DataAccessError(res.status, `put artifact failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { hash: string };
      return body.hash;
    },

    async get(hash) {
      const res = await fetch(`${baseUrl}/api/v1/data/artifacts/${hash}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new DataAccessError(res.status, `get artifact failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { artifact: Artifact };
      return body.artifact;
    },
  };
}
