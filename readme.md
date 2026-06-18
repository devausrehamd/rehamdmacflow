# QMS Agent

Local document-drafting agent built on LangGraph.js. Runs entirely on macOS with Ollama (LLM + embeddings), Qdrant (vectors), and Redis (memory). No cloud services, no API calls leaving the machine.

## Prerequisites

- macOS (Apple Silicon recommended; Intel will work but slower)
- [Homebrew](https://brew.sh)
- ~10GB free disk space (mostly for models)
- 16GB RAM minimum, 36GB+ recommended

## Quick Start

```bash
# Clone and enter the project
git clone <repo-url> qms-agent
cd qms-agent

# Make scripts executable
chmod +x setup.sh teardown.sh

# Run setup — installs everything and starts services
./setup.sh

# Configure your QMS folder path
# Edit .env and set QMS_FOLDER to the path of your QMS documents

# Ingest your documents and run the agent
npm run ingest
npm run agent
```

The setup script is **idempotent** — safe to re-run any time. It'll skip steps that are already done.

## What `setup.sh` Does

1. Installs Homebrew packages from `Brewfile` (Node, Ollama, Redis, OrbStack, supporting tools)
2. Starts Redis and Ollama as background services
3. Pulls the required LLM and embedding models
4. Brings up a Qdrant container with a persistent volume at `~/qms-agent-data/qdrant`
5. Installs the Claude Code CLI globally
6. Runs `npm install` for the project dependencies
7. Copies `.env.example` to `.env` if needed
8. Verifies all services are reachable

If any step fails it stops with a clear error.

## Manual Installation

```bash
# Install brew packages declaratively
brew bundle

# Start services
brew services start redis
brew services start ollama

# Pull models
ollama pull qwen2.5:7b-instruct-q4_K_M
ollama pull mxbai-embed-large

# Bring up Qdrant
docker run -d --name qdrant \
  -p 6333:6333 -p 6334:6334 \
  -v ~/qms-agent-data/qdrant:/qdrant/storage \
  qdrant/qdrant

# Project deps
npm install

# Config
cp .env.example .env
# edit .env
```

## Service URLs

After setup:

- Ollama API: http://localhost:11434
- Qdrant: http://localhost:6333 (dashboard at `/dashboard`)
- Redis: `localhost:6379` (use `redis-cli`)

## Common Tasks

```bash
npm run ingest          # Re-embed QMS folder into Qdrant
npm run agent           # Run the drafting agent
npm run test-retrieval  # Quick search sanity check
npm run reset           # Drop and recreate the Qdrant collection
npm run seed            # Populate Redis with example project facts
npm run typecheck       # Type-check without running
npm run lint            # ESLint
npm run format          # Prettier
```

## Tearing Down

```bash
./teardown.sh           # Stop services, keep data
./teardown.sh --purge   # Stop services and delete all data (asks for confirmation)
```

`--purge` deletes the Qdrant volume and flushes Redis. It does not remove Ollama models — those are usually worth keeping. To remove them too:

```bash
ollama rm qwen2.5:7b-instruct-q4_K_M mxbai-embed-large
```

## Troubleshooting

**`brew bundle` fails on `cask "orbstack"`** — if you already have Docker Desktop installed, either uninstall Docker Desktop or comment the OrbStack line in `Brewfile`. They conflict.

**Ollama models won't pull** — check disk space (`df -h`) and that Ollama is actually running (`brew services list`).

**Qdrant container starts then stops** — usually a port conflict. Run `lsof -i :6333` to see what else is bound to port 6333.

**`npm install` errors with peer dependency warnings** — try `npm install --legacy-peer-deps`. The LangChain ecosystem occasionally has peer dep mismatches that resolve fine in practice.

**Agent runs but produces low-quality JSON** — the 7B model is on the edge of reliable structured output. Either lower temperature in `src/agent/nodes.ts`, strengthen the "JSON only" instruction, or step up to `qwen2.5:14b-instruct-q4_K_M` (~8.5GB).

**Cold-start latency on first request** — Ollama unloads idle models after a default timeout. Set `OLLAMA_KEEP_ALIVE=24h` in your shell environment to keep models hot.

## Project Documentation

- `CLAUDE.md` — Project orientation for Claude Code (also useful as a human read)
- `docs/setup_tutorial.md` — Detailed walkthrough of the architecture and each phase
- `docs/integration.md` — System-level integration and example flows