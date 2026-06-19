// The pipeline tying everything together:
//   source sync -> file discovery -> conversion -> chunking -> qdrant write

import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { qdrant } from "../clients.js";
import { syncGitSource } from "./git-source.js";
import { syncLocalSource } from "./local-source.js";
import { discoverFiles } from "./discover.js";
import { convertFile } from "./converters.js";
import { chunkDocument } from "./chunkers.js";
import { QdrantWriter } from "./qdrant-writer.js";
import type { IngestionConfig, IngestionStats, SourceConfig } from "./types.js";

export async function loadConfig(configPath: string): Promise<IngestionConfig> {
  const raw = await readFile(resolve(configPath), "utf-8");
  return JSON.parse(raw) as IngestionConfig;
}

async function syncSource(source: SourceConfig): Promise<string> {
  switch (source.type) {
    case "git":
      return syncGitSource(source);
    case "local":
      return syncLocalSource(source);
    default:
      throw new Error(`Unknown source type: ${source.type}`);
  }
}

export async function runIngestion(
  config: IngestionConfig,
): Promise<IngestionStats> {
  const startTime = Date.now();
  const stats: IngestionStats = {
    filesDiscovered: 0,
    filesSkipped: 0,
    filesConverted: 0,
    filesFailed: 0,
    totalChunks: 0,
    totalPoints: 0,
    errors: [],
    elapsedSeconds: 0,
  };

  // Step 1: Sync the source (git pull or local path resolve)
  console.log("\n=== Stage 1: Sync source ===");
  const sourceRoot = await syncSource(config.source);
  const ingestRoot = config.source.subpath
    ? join(sourceRoot, config.source.subpath)
    : sourceRoot;

  // Step 2: Discover files
  console.log("\n=== Stage 2: Discover files ===");
  const files = await discoverFiles(ingestRoot, config.conversion);
  stats.filesDiscovered = files.length;
  console.log(`Discovered ${files.length} files to process`);

  if (files.length === 0) {
    console.warn("No files matched. Check your configuration's strategies and skipPatterns.");
    stats.elapsedSeconds = (Date.now() - startTime) / 1000;
    return stats;
  }

  const byExt = new Map<string, number>();
  for (const f of files) byExt.set(f.extension, (byExt.get(f.extension) ?? 0) + 1);
  for (const [ext, count] of byExt) {
    console.log(`  ${ext}: ${count}`);
  }

  // Step 3: Ensure Qdrant collection exists
  console.log("\n=== Stage 3: Prepare Qdrant ===");
  const writer = new QdrantWriter(qdrant, config.qdrant);
  await writer.ensureCollection();

  // Step 4: Convert, chunk, and ingest each file
  console.log("\n=== Stage 4: Convert and ingest ===");
  for (const file of files) {
    try {
      await writer.deleteByPath(file.relativePath);

      const strategy = config.conversion.strategies[file.extension];
      if (!strategy) {
        stats.filesSkipped++;
        continue;
      }

      console.log(`  [${file.extension}] ${file.relativePath}`);
      const converted = await convertFile(
        file,
        strategy,
        config.conversion.outputPath,
      );
      stats.filesConverted++;

      const chunks = chunkDocument(converted, config.chunking);
      stats.totalChunks += chunks.length;

      const pointsWritten = await writer.writeDocument(converted, chunks);
      stats.totalPoints += pointsWritten;
      console.log(`    -> ${chunks.length} chunks, ${pointsWritten} points`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.filesFailed++;
      stats.errors.push({ file: file.relativePath, error: message });
      console.error(`    FAILED: ${message}`);
    }
  }

  stats.elapsedSeconds = (Date.now() - startTime) / 1000;
  return stats;
}

export function printStats(stats: IngestionStats): void {
  console.log("\n=== Ingestion Summary ===");
  console.log(`  Files discovered: ${stats.filesDiscovered}`);
  console.log(`  Files converted:  ${stats.filesConverted}`);
  console.log(`  Files skipped:    ${stats.filesSkipped}`);
  console.log(`  Files failed:     ${stats.filesFailed}`);
  console.log(`  Total chunks:     ${stats.totalChunks}`);
  console.log(`  Points in Qdrant: ${stats.totalPoints}`);
  console.log(`  Elapsed:          ${stats.elapsedSeconds.toFixed(1)}s`);

  if (stats.errors.length > 0) {
    console.log("\n  Errors:");
    for (const e of stats.errors) {
      console.log(`    - ${e.file}: ${e.error}`);
    }
  }
}