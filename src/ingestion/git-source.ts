// Fetch documents from a git repository.
// Clones on first run, pulls on subsequent runs.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SourceConfig } from "./types.js";

const exec = promisify(execFile);

export async function syncGitSource(config: SourceConfig): Promise<string> {
  if (config.type !== "git") {
    throw new Error(`Source type '${config.type}' is not 'git'`);
  }

  const localPath = resolve(config.localPath);

  if (existsSync(localPath)) {
    return pullExisting(localPath, config.branch);
  } else {
    return cloneFresh(config.url, config.branch, localPath);
  }
}

async function cloneFresh(url: string, branch: string, localPath: string): Promise<string> {
  console.log(`Cloning ${url} (branch: ${branch}) to ${localPath}...`);
  await mkdir(dirname(localPath), { recursive: true });

  await exec("git", [
    "clone",
    "--branch", branch,
    "--single-branch",
    "--depth", "1",
    url,
    localPath,
  ]);

  const { stdout: sha } = await exec("git", ["-C", localPath, "rev-parse", "HEAD"]);
  console.log(`Cloned at commit ${sha.trim().slice(0, 8)}`);
  return localPath;
}

async function pullExisting(localPath: string, branch: string): Promise<string> {
  console.log(`Updating existing clone at ${localPath}...`);

  // Verify it is actually a git repo
  try {
    await exec("git", ["-C", localPath, "rev-parse", "--git-dir"]);
  } catch {
    console.warn(`Path exists but is not a git repo. Removing and re-cloning.`);
    await rm(localPath, { recursive: true, force: true });
    throw new Error("RECLONE_NEEDED");
  }

  // Fetch and reset to remote branch
  // Using reset --hard rather than pull, because the source repo is read-only
  // for our purposes and we don't care about local changes (there shouldn't be any).
  await exec("git", ["-C", localPath, "fetch", "origin", branch, "--depth", "1"]);
  await exec("git", ["-C", localPath, "reset", "--hard", `origin/${branch}`]);
  await exec("git", ["-C", localPath, "clean", "-fdx"]);

  const { stdout: sha } = await exec("git", ["-C", localPath, "rev-parse", "HEAD"]);
  console.log(`Updated to commit ${sha.trim().slice(0, 8)}`);
  return localPath;
}