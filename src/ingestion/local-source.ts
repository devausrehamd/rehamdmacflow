// Local filesystem "source" - just resolves and validates the configured path.
// No syncing needed; the files are already there.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SourceConfig } from "./types.js";

export async function syncLocalSource(config: SourceConfig): Promise<string> {
  if (config.type !== "local") {
    throw new Error(`Source type '${config.type}' is not 'local'`);
  }

  // For local sources, we use 'url' as the filesystem path.
  // The 'branch' and 'localPath' fields are ignored.
  if (!config.url) {
    throw new Error(
      "Local source needs 'url' set to the absolute path of your QMS folder.",
    );
  }

  const expandedPath = config.url.startsWith("~/")
    ? config.url.replace("~", process.env.HOME ?? "")
    : config.url;
  const absolutePath = resolve(expandedPath);

  if (!existsSync(absolutePath)) {
    throw new Error(`Local source path does not exist: ${absolutePath}`);
  }

  const stats = statSync(absolutePath);
  if (!stats.isDirectory()) {
    throw new Error(`Local source path is not a directory: ${absolutePath}`);
  }

  console.log(`Using local source: ${absolutePath}`);
  return absolutePath;
}