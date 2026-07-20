// scripts/smoke-test-manifest.ts
//
// The agent manifest (Stage 2 of the agent-platform spec). Proves the config
// contract that specialises a generic runtime at boot:
//
//   - a valid manifest parses; the shipped sample loads and pins a config commit
//   - required fields (name, role, capabilities, identity) are enforced
//   - the role is a closed enum; capabilities need at least one
//   - defaults fill ingestion / resources / permissions when omitted
//   - agentCardFromManifest maps a manifest + runtime facts to the Agent Card
//     (name, capabilities, role as group, mode, configCommit)
//
// Pure: no network, DB, or LLM.
//
// Usage: npm run smoke:manifest

import { parseManifest, loadManifest, agentCardFromManifest, type AgentManifest } from "../src/platform/manifest.js";

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
function rejects(name: string, fn: () => unknown): void {
  try {
    fn();
    check(name, false, "expected a validation error, none thrown");
  } catch {
    check(name, true);
  }
}

const MANIFEST_PATH = "platform/manifests/qms-eng-research.json";

// A minimal valid manifest (only the required fields).
const minimal = {
  name: "test-agent",
  role: "researcher",
  capabilities: ["research:test"],
  identity: { idServerUrl: "http://localhost:3001", issuer: "rehamd-idserver", serviceTokenEnv: "IDSERVER_SERVICE_TOKEN" },
};

function main(): void {
  console.log("=== Agent manifest smoke test ===\n");

  // --- Shipped sample loads + pins a commit ---
  const loaded = loadManifest(MANIFEST_PATH, { commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
  check("shipped manifest loads and validates", loaded.manifest.name === "qms-eng-research");
  check("  role and capability are as declared",
    loaded.manifest.role === "researcher" && loaded.manifest.capabilities.includes("research:qms"));
  check("  loadManifest pins the config commit", loaded.configCommit === "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  check("  ingestion pipeline parsed", loaded.manifest.ingestion.sources[0]?.pipeline.includes("docx->md") === true);

  // --- Minimal valid manifest + defaults ---
  const m: AgentManifest = parseManifest(minimal);
  check("minimal manifest parses", m.name === "test-agent");
  check("  defaults: ingestion schedule on-boot, state persistent",
    m.ingestion.schedule === "on-boot" && m.ingestion.state === "persistent");
  check("  defaults: resources cpu>=1, memory>=1024", m.resources.cpu >= 1 && m.resources.memoryMb >= 1024);

  // --- Required fields + closed vocab enforced ---
  rejects("missing name -> rejected", () => parseManifest({ ...minimal, name: undefined }));
  rejects("missing identity -> rejected", () => parseManifest({ ...minimal, identity: undefined }));
  rejects("missing idServerUrl in identity -> rejected", () =>
    parseManifest({ ...minimal, identity: { issuer: "x", serviceTokenEnv: "Y" } }));
  rejects("unknown role -> rejected", () => parseManifest({ ...minimal, role: "wizard" }));
  rejects("empty capabilities -> rejected", () => parseManifest({ ...minimal, capabilities: [] }));

  // --- Manifest -> Agent Card ---
  const card = agentCardFromManifest(loaded.manifest, {
    guid: "agt_test", address: "http://localhost:4000", gitCommit: "codecommit123", mode: "production", configCommit: loaded.configCommit,
  });
  check("card carries the manifest name", card.name === "qms-eng-research");
  check("card advertises the manifest capabilities", JSON.stringify(card.capabilities) === JSON.stringify(["research:qms"]));
  check("card group is the role", card.group === "researcher");
  check("card mode is the runtime mode", card.mode === "production");
  check("card gitCommit is the CODE commit, not the config commit",
    card.gitCommit === "codecommit123" && card.gitCommit !== loaded.configCommit);
  check("card advertises the pinned configCommit", card.configCommit === loaded.configCommit);

  console.log("");
  if (failed === 0) console.log(`${GREEN}Agent manifest is sound.${NC}`);
  else console.log(`${RED}${failed} check(s) failed.${NC}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
