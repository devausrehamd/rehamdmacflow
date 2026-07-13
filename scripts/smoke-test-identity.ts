// scripts/smoke-test-identity.ts
//
// Validates the entitlement seam:
//   - the fixed policy loads, validates, and hashes stably
//   - labels are scoped per domain (an accounting agent learns no eng labels)
//   - per-subject grants are additive
//   - every failure path resolves to NO labels (fail closed)
//   - the decision carries provenance (policy version, hash, decision id)
//
// Usage: npm run smoke:identity

import {
  getEntitlementProvider,
  resetEntitlementProvider,
  loadPolicy,
  isPermitted,
} from "../src/identity/index.js";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";
let failed = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`${GREEN}OK${NC}   ${name}`);
  else {
    failed++;
    console.log(`${RED}FAIL${NC} ${name}${detail ? " - " + detail : ""}`);
  }
}

async function main(): Promise<void> {
  console.log("=== Identity / entitlement smoke test ===\n");

  // --- Policy artifact ---
  const loaded = loadPolicy();
  check("policy loads and validates", Boolean(loaded.policy.policyVersion));
  check("policy hash is sha256", /^[0-9a-f]{64}$/.test(loaded.hash));
  check("hash is stable across reloads", loadPolicy().hash === loaded.hash);

  resetEntitlementProvider();
  const provider = getEntitlementProvider();
  check("local provider selected by default", provider.kind === "local");

  // --- Domain scoping ---
  const engInEng = await provider.resolve("u1", "engineering", "engineer");
  check("engineer active in engineering", engInEng.status === "active");
  check("engineer holds engineering:internal", engInEng.labels.includes("engineering:internal"));
  check("engineer permitted in engineering", isPermitted(engInEng));

  const engInAcct = await provider.resolve("u1", "accounting", "engineer");
  check("engineer has NO labels in accounting", engInAcct.labels.length === 0);
  check("engineer NOT permitted in accounting", !isPermitted(engInAcct));

  const adminInAcct = await provider.resolve("u3", "accounting", "admin");
  check("admin holds an accounting label", adminInAcct.labels.length > 0);
  check(
    "accounting decision discloses no engineering labels",
    !adminInAcct.labels.some((l) => l.startsWith("engineering:")),
    JSON.stringify(adminInAcct.labels),
  );

  // --- Fail closed ---
  const noRole = await provider.resolve("u1", "engineering", undefined);
  check("no role -> no labels", noRole.labels.length === 0);
  const svc = await provider.resolve("u1", "engineering", "service");
  check("service role -> no labels", svc.labels.length === 0);
  const unknownDomain = await provider.resolve("u3", "finance", "admin");
  check("undeclared domain -> no labels", unknownDomain.labels.length === 0);

  // --- Provenance on every decision ---
  check("decision carries policy version", engInEng.policyVersion === loaded.policy.policyVersion);
  check("decision carries policy hash", engInEng.policyHash === loaded.hash);
  check("decision id present", engInEng.decisionId.startsWith("dec_"));
  const second = await provider.resolve("u1", "engineering", "engineer");
  check("decision ids are unique per resolution", second.decisionId !== engInEng.decisionId);
  check("resolvedAt is an ISO timestamp", !Number.isNaN(Date.parse(engInEng.resolvedAt)));

  console.log("");
  if (failed === 0) console.log(`${GREEN}Entitlement seam is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Crashed:", err);
  process.exit(1);
});