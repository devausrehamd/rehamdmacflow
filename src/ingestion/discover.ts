// Walk the source tree and produce a list of files to ingest,
// applying skip patterns and computing per-file hashes.

import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, extname } from "node:path";
import { minimatch } from "minimatch";
import type { SourceFile, ConversionConfig } from "./types.js";

export async function discoverFiles(
  rootPath: string,
  conversionConfig: ConversionConfig,
): Promise<SourceFile[]> {
  const knownExtensions = new Set(Object.keys(conversionConfig.strategies));
  const files: SourceFile[] = [];

  await walk(rootPath, rootPath, async (absolutePath) => {
    const relativePath = relative(rootPath, absolutePath);

    // Skip-pattern check
    for (const pattern of conversionConfig.skipPatterns) {
      if (minimatch(relativePath, pattern, { dot: true })) {
        return;
      }
    }

    const ext = extname(absolutePath).toLowerCase();
    if (!knownExtensions.has(ext)) {
      return; // unknown type, ignore silently
    }

    const stats = await stat(absolutePath);
    const buf = await readFile(absolutePath);
    const sha = createHash("sha256").update(buf).digest("hex");

    files.push({
      absolutePath,
      relativePath,
      extension: ext,
      sizeBytes: stats.size,
      sha256: sha,
    });
  });

  return files;
}

async function walk(
  root: string,
  current: string,
  visit: (path: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      // Quick skip for very common directories
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      await walk(root, path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}