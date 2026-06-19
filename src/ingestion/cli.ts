// CLI entry point - reads config and runs the ingestion pipeline.
//
// Usage:
//   npm run ingest:repo
//   tsx src/ingestion/cli.ts [path/to/ingestion.json]

import { loadConfig, runIngestion, printStats } from "./pipeline.js";

const configPath = process.argv[2] ?? "config/ingestion.json";

console.log(`Loading ingestion config from ${configPath}`);
const config = await loadConfig(configPath);
console.log(`Source: ${config.source.url} (${config.source.branch})`);
console.log(`Target collection: ${config.qdrant.collection}`);

const stats = await runIngestion(config);
printStats(stats);

// Exit code reflects whether any files failed - useful for CI / VSCode tasks
process.exit(stats.filesFailed > 0 ? 1 : 0);