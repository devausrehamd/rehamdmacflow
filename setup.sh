#!/usr/bin/env bash
# setup.sh - Bring up the local QMS Agent stack on macOS.
#
# Idempotent: safe to re-run. Will skip steps that are already done.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

step()  { echo -e "\n${BLUE}==>${NC} ${GREEN}$1${NC}"; }
info()  { echo -e "    $1"; }
warn()  { echo -e "${YELLOW}WARN:${NC} $1"; }
fail()  { echo -e "${RED}FAIL:${NC} $1" >&2; exit 1; }

wait_for() {
    local description="$1"
    local cmd="$2"
    local timeout="${3:-30}"
    local elapsed=0
    while ! eval "$cmd" >/dev/null 2>&1; do
        if [[ $elapsed -ge $timeout ]]; then
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        if [[ $((elapsed % 5)) -eq 0 ]]; then
            info "Still waiting for $description... (${elapsed}s)"
        fi
    done
    return 0
}

# Preflight
step "Preflight checks"

if [[ "$(uname)" != "Darwin" ]]; then
    fail "This script is for macOS only."
fi
info "macOS detected"

if ! command -v brew >/dev/null 2>&1; then
    fail "Homebrew is not installed. Install from https://brew.sh and re-run."
fi
info "Homebrew detected"

if [[ ! -f Brewfile ]]; then
    fail "Brewfile not found in current directory. Run this script from the project root."
fi

# Node.js / nvm check
# We rely on nvm rather than brew for node version management. This
# avoids the Node 25 compatibility issues we hit (simdjson linking,
# undici fetch handler incompatibilities with @qdrant/js-client-rest).
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is not on PATH. Install nvm (https://github.com/nvm-sh/nvm) and run 'nvm use' in this directory."
fi

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [[ $NODE_MAJOR -ne 22 ]]; then
    warn "Node version is $(node --version), but this project requires Node 22 LTS."
    warn "Newer versions (Node 25+) have known compatibility issues with the LangChain/Qdrant stack."
    if [[ -f .nvmrc ]] && command -v nvm >/dev/null 2>&1; then
        warn "Run 'nvm use' to switch to the version pinned in .nvmrc."
    fi
    warn "Continuing anyway - if you hit fetch errors, this is why."
else
    info "Node 22 LTS detected: $(node --version)"
fi

# Step 1: Brew bundle
step "Installing Homebrew packages"
brew bundle --file=./Brewfile
info "Brew packages installed"

# Step 2: Start background services
step "Starting background services"

if brew services list | grep -q "^redis.*started"; then
    info "Redis already running"
else
    brew services start redis
    info "Redis started"
fi

if brew services list | grep -q "^ollama.*started"; then
    info "Ollama already running"
else
    brew services start ollama
    info "Ollama started"
fi

# Step 3: Start Colima
step "Starting Colima (Docker daemon)"

if colima status 2>/dev/null | grep -q "Running"; then
    info "Colima already running"
else
    info "Starting Colima VM (this takes 20-40s on first run)..."
    colima start --cpu 4 --memory 4 --disk 50
fi

current_ctx=$(docker context show 2>/dev/null || echo "none")
if [[ "$current_ctx" != "colima" ]]; then
    info "Switching docker context to 'colima' (was '$current_ctx')"
    docker context use colima >/dev/null 2>&1 || warn "Could not switch context; continuing"
fi

if ! wait_for "Docker daemon" "docker info" 30; then
    fail "Colima started but docker CLI cannot reach the daemon. Try: colima restart"
fi
info "Docker daemon reachable"

# Step 4: Pull Ollama models
step "Pulling Ollama models (this can take several minutes on first run)"

if ! wait_for "Ollama API" "curl -sf http://localhost:11434/api/tags" 30; then
    fail "Ollama API not reachable after 30s. Check 'brew services list'."
fi

if ollama list 2>/dev/null | grep -q "qwen2.5:7b-instruct-q4_K_M"; then
    info "qwen2.5:7b-instruct-q4_K_M already pulled"
else
    info "Pulling qwen2.5:7b-instruct-q4_K_M (~4.7GB)..."
    ollama pull qwen2.5:7b-instruct-q4_K_M
fi

if ollama list 2>/dev/null | grep -q "mxbai-embed-large"; then
    info "mxbai-embed-large already pulled"
else
    info "Pulling mxbai-embed-large (~670MB)..."
    ollama pull mxbai-embed-large
fi

# Step 5: Qdrant container
step "Bringing up Qdrant container"

QDRANT_DATA_DIR="$HOME/qms-agent-data/qdrant"
mkdir -p "$QDRANT_DATA_DIR"

if docker ps --format '{{.Names}}' | grep -q '^qdrant$'; then
    info "Qdrant container already running"
elif docker ps -a --format '{{.Names}}' | grep -q '^qdrant$'; then
    info "Qdrant container exists but stopped; starting..."
    docker start qdrant >/dev/null
else
    info "Creating Qdrant container with persistent volume at $QDRANT_DATA_DIR"
    docker run -d \
        --name qdrant \
        --restart unless-stopped \
        -p 6333:6333 \
        -p 6334:6334 \
        -v "$QDRANT_DATA_DIR:/qdrant/storage" \
        qdrant/qdrant >/dev/null
fi

if ! wait_for "Qdrant API" "curl -sf http://localhost:6333/" 30; then
    fail "Qdrant container started but API not reachable after 30s."
fi
info "Qdrant API responding"


# Step 6: Project dependencies
step "Installing Node project dependencies"

if [[ -f package.json ]]; then
    npm install
    info "npm install complete"
else
    warn "No package.json in current directory."
fi

# Step 7: Environment file
step "Environment configuration"

if [[ -f .env ]]; then
    info ".env already exists; not overwriting"
elif [[ -f .env.example ]]; then
    cp .env.example .env
    info ".env created from .env.example - edit QMS_FOLDER before running the agent"
else
    warn "Neither .env nor .env.example found; you will need to create .env manually"
fi

# Step 8: Verify
step "Verifying services"

verify() {
    local name="$1"
    local cmd="$2"
    if eval "$cmd" >/dev/null 2>&1; then
        echo -e "    ${GREEN}OK${NC}  $name"
        return 0
    else
        echo -e "    ${RED}FAIL${NC} $name"
        return 1
    fi
}

ALL_OK=true
verify "Ollama API"     "curl -sf http://localhost:11434/api/tags"               || ALL_OK=false
verify "Qdrant API"     "curl -sf http://localhost:6333/"                        || ALL_OK=false
verify "Redis"          "redis-cli ping | grep -q PONG"                          || ALL_OK=false
verify "Colima/Docker"  "docker info"                                            || ALL_OK=false
verify "Node 22"        "test \"\$(node -e 'process.stdout.write(process.versions.node.split(\".\")[0])')\" = '22'" || ALL_OK=false
verify "npm"            "npm --version"                                          || ALL_OK=false

echo ""

if $ALL_OK; then
    echo -e "${GREEN}Setup complete.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Edit .env and set QMS_FOLDER if needed"
    echo ""
    echo "  2. Verify end-to-end:"
    echo "       npm run agent      # foundation smoke test"
    echo "       npm run ingest:repo # ingest QMS documents"
    echo ""
    echo "Service URLs:"
    echo "  Ollama:  http://localhost:11434"
    echo "  Qdrant:  http://localhost:6333  (dashboard: /dashboard)"
    echo "  Redis:   localhost:6379"
else
    echo -e "${RED}Setup completed with errors.${NC} See failed checks above."
    exit 1
fi