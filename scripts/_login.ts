// scripts/_login.ts
//
// Shared test helper: log into the stack's auth server (the ID Server) and
// return the bearer token the Agent trusts. The integration tests use this so
// they exercise the REAL auth path — a token signed by the ID Server, with
// entitlements resolved from it per request — instead of minting a local user.
//
// The Agent runs in http identity mode: it verifies the ID Server's signature
// (shared JWT secret) and never mirrors the user locally, so a directory user
// like `dmaher` works end-to-end without existing in the Agent's users table.

export const IDSERVER_URL = process.env.QMS_IDENTITY_URL ?? "http://localhost:3001";

/** POST /v1/login and return the bearer token. Throws with a clear message if
 *  the ID Server is down or the user/password is wrong. */
export async function idServerLogin(userId: string, password = "thisisatest"): Promise<string> {
  const res = await fetch(`${IDSERVER_URL}/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  if (!res.ok) {
    throw new Error(
      `ID Server login failed (${res.status}) for '${userId}' at ${IDSERVER_URL}/v1/login. ` +
        `Is the ID Server running (./stack.sh start idserver) and is '${userId}' in its directory?`,
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error(`ID Server login for '${userId}' returned no token.`);
  return body.token;
}
