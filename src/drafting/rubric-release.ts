// src/drafting/rubric-release.ts
//
// Pull the released rubric set from git into this agent's working copy.
//
// This is the other half of the promotion path. A rubric is authored as a draft
// in some sandbox, exported, and committed to git where a human reviews it;
// this is how every OTHER agent then picks it up. It does not bypass review -
// it consumes the artifact review produced.
//
// Rules this file exists to enforce:
//
//   RUBRICS ONLY. It checks out `rubrics/` at the release ref and nothing else.
//   A `git pull` would drag in code, and under a watcher that hot-reloads a
//   running agent mid-request. Changing what an agent BELIEVES is a rubric
//   update; changing what an agent IS is a deployment, and a button is not how
//   you deploy.
//
//   ALL-OR-NOTHING. Files are written, then every rubric is re-validated. If
//   any fails - the schema can outrun the code, since only rubrics moved - the
//   previous files are restored exactly. A half-applied rubric set is a
//   standard nobody wrote.
//
//   NEVER THROUGH GIT'S INDEX. Files are materialised with `git show`, not
//   `git checkout -- path`. Checkout writes the INDEX as well as the working
//   tree, which made the agent's own update leave rubrics/ permanently
//   "modified": the first pull worked and every later one was refused as dirty.
//   `git show` only ever reads.
//
//   ROLL BACK TO WHAT WAS THERE, NOT TO HEAD. The previous contents are held in
//   memory and restored verbatim. Reverting to HEAD instead would throw away a
//   release pulled earlier and silently re-standardise the agent on whatever
//   its checkout happens to contain.
//
//   PINNED REF, NOT "LATEST". The ref is configured (QMS_RUBRICS_RELEASE_REF),
//   so merging to main does not silently re-standardise every agent. Releasing
//   is a deliberate second act.
//
//   Note this DOES overwrite hand edits to the rubrics directory, by design.
//   Rubrics are released artifacts: you author them as drafts and export them
//   through git, never by editing a sandbox's files in place.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import { resetAliasIndex } from "../agent/intent.js";
import { getRubric, listRubricTypes, resetRubricCache, rubricSetHash } from "./rubric-loader.js";
import { validateRubric } from "./rubric-validate.js";

/** What one document type's rubric did across the update. */
export interface RubricChange {
  documentType: string;
  change: "added" | "updated" | "removed" | "unchanged";
  fromHash: string | null;
  toHash: string | null;
}

export interface RubricUpdateResult {
  ref: string;
  /** The commit the ref resolved to - the exact released standard now loaded. */
  refCommit: string;
  fromSetHash: string;
  toSetHash: string;
  changed: RubricChange[];
  /** True when nothing moved: the agent was already on the released set. */
  upToDate: boolean;
}

export class RubricUpdateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RubricUpdateError";
  }
}

const RUBRICS_PATH = "rubrics";

/** Run git with argv (never a shell string) so no value can be interpreted.
 *  Trimmed — for commands whose output is an id or a list. */
function git(args: string[]): string {
  return gitRaw(args).trim();
}

/** Run git and return its output BYTE-FOR-BYTE.
 *
 *  Required for `git show`: a rubric's content hash is the audit anchor, so a
 *  file must round-trip exactly. Trimming here (and re-adding a newline) made
 *  every rubric's bytes shift on the first pull, so all three reported as
 *  "updated" when only one had actually changed — a false claim that the
 *  governing standard had moved. */
function gitRaw(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}

/** documentType -> content hash, as currently loaded. */
function snapshot(): Map<string, string> {
  const m = new Map<string, string>();
  for (const type of listRubricTypes()) m.set(type, getRubric(type).contentHash);
  return m;
}

/** Re-read rubrics from disk, rebuilding everything derived from them. */
function reload(): void {
  resetRubricCache();
  resetAliasIndex(); // derived from the rubric set - stale index = unroutable type
}

/**
 * Fetch the release ref and check out its rubrics. Returns what changed.
 * Throws RubricUpdateError with an HTTP-ish status on any refusal.
 */
export function updateRubricsFromRelease(): RubricUpdateResult {
  const ref = config.rubricsReleaseRef;

  // 1. Fetch. Best effort: an agent that cannot reach the remote may still be
  //    on a ref it already has, and should report "up to date" rather than fail.
  try {
    git(["fetch", "origin", "--tags", "--quiet"]);
  } catch {
    // fall through - resolving the ref below is the real test
  }

  // 2. Resolve the ref. Failing here names it, because "no release ref" is a
  //    setup problem and must never silently fall back to another branch.
  let refCommit: string;
  try {
    refCommit = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new RubricUpdateError(
      400,
      `Release ref '${ref}' does not exist. Create it (or set QMS_RUBRICS_RELEASE_REF) - ` +
        "refusing to guess which ref is the released standard.",
    );
  }

  const before = snapshot();
  const fromSetHash = rubricSetHash();
  // The exact bytes currently on disk. This, not HEAD, is what a failed update
  // must restore.
  const backup = readRubricDir();

  // 3. Materialise the released rubrics. Read-only git operations only.
  try {
    applyRubricsFromRef(refCommit);
  } catch (err) {
    restoreRubricDir(backup);
    reload();
    throw new RubricUpdateError(500, `Could not read rubrics at ${ref}: ${msg(err)}`);
  }

  // 4. Re-read and validate EVERY rubric, not only the changed ones: a release
  //    is usable only if the whole set is.
  try {
    reload();
    const failures: { documentType: string; issues: unknown }[] = [];
    for (const type of listRubricTypes()) {
      const result = validateRubric(getRubric(type).rubric);
      if (!result.valid) failures.push({ documentType: type, issues: result.issues });
    }
    if (failures.length > 0) {
      restoreRubricDir(backup);
      reload();
      throw new RubricUpdateError(
        422,
        `The released rubrics at '${ref}' are not valid for this agent, so nothing was applied. ` +
          "This usually means the rubric schema is ahead of this agent's code.",
        { failures },
      );
    }
  } catch (err) {
    if (err instanceof RubricUpdateError) throw err;
    // A rubric that will not even parse throws out of the loader.
    restoreRubricDir(backup);
    reload();
    throw new RubricUpdateError(422, `Released rubrics could not be loaded, so nothing was applied: ${msg(err)}`);
  }

  const after = snapshot();
  const toSetHash = rubricSetHash();

  return {
    ref,
    refCommit,
    fromSetHash,
    toSetHash,
    changed: diff(before, after),
    upToDate: fromSetHash === toSetHash,
  };
}

/** Every rubric file's bytes, as they are on disk right now. */
function readRubricDir(): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(RUBRICS_PATH)) return out;
  for (const f of readdirSync(RUBRICS_PATH).filter((f) => f.endsWith(".json"))) {
    out.set(f, readFileSync(join(RUBRICS_PATH, f), "utf8"));
  }
  return out;
}

/** Put the directory back exactly as the snapshot found it, including removing
 *  files the failed attempt introduced. */
function restoreRubricDir(backup: Map<string, string>): void {
  for (const f of readdirSync(RUBRICS_PATH).filter((f) => f.endsWith(".json"))) {
    if (!backup.has(f)) rmSync(join(RUBRICS_PATH, f), { force: true });
  }
  for (const [f, content] of backup) writeFileSync(join(RUBRICS_PATH, f), content, "utf8");
}

/**
 * Write the rubric files as they exist at `commit`, and delete any local rubric
 * the release no longer has (a withdrawn document type must actually go).
 *
 * Uses `git show`, which only reads. `git checkout <ref> -- path` would also
 * write the index, leaving the working tree permanently "modified" against HEAD
 * and making the agent's own update look like uncommitted user edits.
 */
function applyRubricsFromRef(commit: string): void {
  const listed = git(["ls-tree", "--name-only", commit, `${RUBRICS_PATH}/`])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".json"));

  const released = new Set(listed.map((p) => p.slice(RUBRICS_PATH.length + 1)));

  for (const path of listed) {
    // Raw: the file must land byte-identical to what was committed, or its
    // content hash shifts and the agent reports a standard change that never
    // happened.
    const content = gitRaw(["show", `${commit}:${path}`]);
    writeFileSync(join(RUBRICS_PATH, path.slice(RUBRICS_PATH.length + 1)), content, "utf8");
  }

  // A type dropped from the release must disappear here too, or the agent goes
  // on judging against a standard that was withdrawn.
  for (const f of readdirSync(RUBRICS_PATH).filter((f) => f.endsWith(".json"))) {
    if (!released.has(f)) rmSync(join(RUBRICS_PATH, f), { force: true });
  }
}

function diff(before: Map<string, string>, after: Map<string, string>): RubricChange[] {
  const types = new Set([...before.keys(), ...after.keys()]);
  const out: RubricChange[] = [];
  for (const t of [...types].sort()) {
    const f = before.get(t) ?? null;
    const to = after.get(t) ?? null;
    const change: RubricChange["change"] =
      f === null ? "added" : to === null ? "removed" : f === to ? "unchanged" : "updated";
    out.push({ documentType: t, change, fromHash: f, toHash: to });
  }
  return out;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
