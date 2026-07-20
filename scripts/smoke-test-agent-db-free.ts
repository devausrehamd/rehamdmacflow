// scripts/smoke-test-agent-db-free.ts
//
// The decision-13 guard (refactor R4): the agent role holds no direct database
// client and carries no database credentials. This is the invariant R1–R3 were
// building toward — custody, trace/DAG-History, and vector search all moved
// behind the Data Access API — and this test is what keeps it true as the code
// grows.
//
// It walks the RUNTIME import graph starting from every module under src/agent/,
// following value imports only (import-type lines are erased and pull nothing at
// runtime), and fails if the reachable closure contains a database/vector/cache
// CLIENT — @qdrant/js-client-rest, ioredis, drizzle-orm, pg — or reaches the
// Drizzle db handle (src/db/client.ts) or the schema (src/db/schema.ts).
//
// A new agent-role module that reaches for a DB client fails here, with the exact
// import chain that introduced it. The agent uses the HTTP data clients instead
// (src/data/*-client.ts), which carry a token and no database access.
//
// Pure and fast: reads source files, runs no server and touches no infra.
//
// Usage: npm run smoke:agent-db-free

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const NC = "\x1b[0m";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const AGENT_DIR = resolve(SRC, "agent");

// Bare package specifiers that ARE a database/vector/cache client.
const FORBIDDEN_PACKAGES = ["@qdrant/js-client-rest", "ioredis", "drizzle-orm", "pg", "postgres"];
// Resolved source modules that own or define direct database access.
const FORBIDDEN_MODULES = [resolve(SRC, "db/client.ts"), resolve(SRC, "db/schema.ts")];

/** Every .ts file under a directory. */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) out.push(...walkTs(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Value imports of a file: [{ spec, isType }]. import-type / export-type lines
 *  are marked so the walk can skip them — they are erased at runtime. */
function importsOf(file: string): { spec: string; isType: boolean }[] {
  const src = readFileSync(file, "utf8");
  const out: { spec: string; isType: boolean }[] = [];
  const re = /(^|\n)\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    out.push({ spec: m[4]!, isType: Boolean(m[3]) });
  }
  return out;
}

/** Resolve a relative import spec (".../x.js") to a source .ts path, or null. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(cand) && cand.endsWith(".ts")) return cand;
  }
  return null;
}

interface Violation {
  what: string; // the forbidden package or module
  chain: string[]; // agent entry -> ... -> the module that imported `what`
}

function main(): void {
  console.log("=== Agent is DB-free (decision-13 guard) ===\n");

  const entries = walkTs(AGENT_DIR);
  const visited = new Set<string>();
  const parent = new Map<string, string>(); // module -> who imported it (for chains)
  const violations: Violation[] = [];
  const stack = [...entries];
  for (const e of entries) parent.set(e, "");

  const chainTo = (file: string): string[] => {
    const chain: string[] = [];
    let cur: string | undefined = file;
    while (cur) {
      chain.unshift(relative(SRC, cur));
      cur = parent.get(cur) || undefined;
    }
    return chain;
  };

  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const { spec, isType } of importsOf(file)) {
      if (isType) continue; // erased at runtime — pulls no client

      // Bare package: flag if it is a forbidden client.
      if (!spec.startsWith(".")) {
        const hit = FORBIDDEN_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
        if (hit) violations.push({ what: hit, chain: chainTo(file) });
        continue;
      }

      // Relative: resolve, flag if forbidden, then follow.
      const target = resolveRelative(file, spec);
      if (!target) continue;
      if (FORBIDDEN_MODULES.includes(target)) {
        violations.push({ what: relative(SRC, target), chain: [...chainTo(file), relative(SRC, target)] });
      }
      if (!visited.has(target) && !parent.has(target)) parent.set(target, file);
      if (!visited.has(target)) stack.push(target);
    }
  }

  console.log(`Walked ${visited.size} modules reachable from ${entries.length} agent entry points.\n`);

  if (violations.length === 0) {
    console.log(`${GREEN}OK${NC}   the agent role reaches no database, vector, or cache client`);
    console.log(`\n${GREEN}Agent is DB-free.${NC}`);
    process.exit(0);
  }

  // De-duplicate by (what + immediate importer) for a readable report.
  const seen = new Set<string>();
  for (const v of violations) {
    const key = `${v.what}::${v.chain[v.chain.length - 1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${RED}FAIL${NC} agent reaches '${v.what}'`);
    console.log(`     via: ${v.chain.join(" -> ")}`);
  }
  console.log(`\n${RED}${seen.size} forbidden client import(s) reachable from the agent role.${NC}`);
  process.exit(1);
}

main();
