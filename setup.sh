#!/usr/bin/env bash
# setup.sh - Bring up the local QMS agent stack on macOS
# 
# Note: Safe to re-run. Will skip steps that have already been completed.
#       Please remember to run `chmod +x setup.sh teardown.sh` before executing the script for the first time.
#
# Prerequisites:
# - macOS (Apple Silicon please)
# - Homebrew Installed (https://brew.sh/)
#
# Usage:
# ./setup.sh
# 

set -euo pipefail

# --- Pretty output helpers ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color 

step() {echo -e "${BLUE}==> $1${NC}";}
info() {echo -e "     $1";}
warn() {echo -e "${YELLOW}WARN:${NC} $1";}
fail() {echo -e "${RED}FAIL:${NC} $1" >&2; exit 1;}

# -- Preflight checks ---
step "Preflight checks"

if [[ $(uname) != "Darwin" ]]; then
    fail "This setup script is intended for macOS. Detected OS: $(uname)"
fi

info "macOS detected"

if ! command -v brew &> /dev/null; then
    fail "Homebrew is not installed. Please install it from https://brew.sh/ and re-run this script."
fi

info "Homebrew detected: $(brew --version | head -n 1)"

if [[ ! -f Brewfile ]]; then
    fail "Brewfile not found. Please ensure you are running this script from the project root."
fi

# -- Step 1: Brew Bundle ---
step "Installing homebrew packages"
brew bundle --file=Brewfile
info "Brew packages installed"

# -- Step 2: Start Background services ---
if brew services list | grep -q "redis.*started"; then
    info "Redis is already running"
else
    step "Starting Redis service"
    brew services start redis
    info "Redis service started"
fi

if brew services list | grep -q "^ollama.*started"; then
    info "Ollama is already running"
else
    step "Starting Ollama service"
    brew services start ollama
    info "Ollama service started"
fi
# ollama can take a few seconds to fully start up, so we'll wait a bit before proceeding
sleep 3

# -- Step 3: Load Ollama Models ---
step "Loading Ollama models (This can take a few minutes on the first run)"

if ollama list | grep -q "qwen2.5:7b-instruct-q4_K_M"; then
    info "Qwen 2.5 model is already loaded in Ollama"
else
    ollama pull qwen2.5:7b-instruct-q4_K_M
    info "Qwen 2.5 model loaded into Ollama"
fi

if ollama list | grep -q "mxbai-embed-large"; then
    info "MXBai Embed Large model is already loaded in Ollama"
else
    ollama pull mxbai-embed-large
    info "MXBai Embed Large model loaded into Ollama"
fi

# -- Step 4: Qdrant container ---
step "Setting up Qdrant vector database"

QDRANT_DATA_DIR="$HOME/qms-agent-data/qdrant"
mkdir -p "$QDRANT_DATA_DIR"

if ! command -v docker &> /dev/null; then
    fail "Docker is not installed. Please install Docker Desktop for macOS and re-run this script."
fi

if docker ps --format '{{.Names}}' | grep -q "^qdrant$"; then
    info "Qdrant container is already running"
    docker start qdrant >/dev/null
else
    step "Creating Qdrant container with a persistent data volume at $QDRANT_DATA_DIR"
    docker run -d \
    --name qdrant \
    --restart unless-stopped \
    -p 6333:6333 \
    -p 6334:6334 \
    -v "$QDRANT_DATA_DIR:/qdrant/storage" \
    qdrant.qdrant >/dev/null
    info "Qdrant container started"
fi

# -- Step 5: Project dependencies ---
step "Installing project dependencies"

if [[ -f package.json ]] then
    npm install
    info "Project dependencies installed"
else
    warn "package.json not found. Skipping npm install. Please ensure you are running this script from the project root."
fi

# -- Step 6: Environment Configuration ---
step "Configuring environment variables"
if [[ -f .env]] then
    info ".env file already exists. Skipping creation."
elif [[ -f .env.example ]]; then
    cp .env.example .env
    info "Copied .env.example to .env. Please review and update any necessary environment variables before running the application."
else
    warn "No .env.example file found. Creating an empty .env file. Please populate it with the necessary environment variables before running the application."         
fi

# -- Step 7: Verify Setup --
step "Verifying setup"

verify() {
    local name="$1"
    local check_cmd="$2"
    if eval "$check_cmd" &> /dev/null; then
        info "$name is running and accessible"
        return 0
    else
        fail "$name is not accessible. Please check the service and try again."
        return 1
    fi
}

ALL_OK=true
verify "Ollama API" "curl -sf http://localhost:11434/api/tags" || ALL_OK=false
verify "Qdrant API" "curl -sf http://localhost:6333" || ALL_OK=false
verify "Redis" "redis-cli ping | grep -q PONG" || ALL_OK=false
verify "Node 2-+" "node -e 'prcoess.exit(process.versions.node.split(\".\")[0] >=20 ? 0 : 1)'" || ALL_OK=false

echo ""

if $ALL_OK; then
    echo -e "${GREEN}All services are up and running!${NC}"
    echo "Next Steps:"
    echo "1. Review and update the .env file and set the QMS FOLDER to the desired location."
    echo "2. Start the ingestion of the QMS FOLDER into Qdrantby running: npm run ingest"
    echo "3. Run a sample draft by running: npm run agent"
    echo ""
    echo "Service URLS:"
    echo "Ollama API: http://localhost:11434"
    echo "Qdrant API: http://localhost:6333" 
    echo "Redis: localhost:6379"


else
    echo -e "${RED}One or more services failed verification. Please review the output above, resolve any issues, and re-run this script if necessary.${NC}"
fi

