#!/usr/bin/env bash
# teardown.sh - Stop services and optionally remove data.
#
# Usage:
#   ./teardown.sh           # Stop services, keep data
#   ./teardown.sh --purge   # Stop services AND delete all data

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

step() { echo -e "\n${BLUE}==>${NC} ${GREEN}$1${NC}"; }
info() { echo -e "    $1"; }
warn() { echo -e "${YELLOW}WARN:${NC} $1"; }

PURGE=false
if [[ "${1:-}" == "--purge" ]]; then
    PURGE=true
fi

# Stop background services
step "Stopping background services"
brew services stop redis  2>/dev/null || warn "Redis service was not running"
brew services stop ollama 2>/dev/null || warn "Ollama service was not running"
info "Services stopped"

# Stop Qdrant container (only if Colima/Docker is running)
step "Stopping Qdrant container"
if docker info >/dev/null 2>&1; then
    if docker ps --format '{{.Names}}' | grep -q '^qdrant$'; then
        docker stop qdrant >/dev/null
        info "Qdrant container stopped"
    else
        info "Qdrant container was not running"
    fi
else
    info "Docker daemon not running; skipping container stop"
fi

# Stop Colima
step "Stopping Colima"
if colima status 2>/dev/null | grep -q "Running"; then
    colima stop
    info "Colima stopped"
else
    info "Colima was not running"
fi

# Purge (optional)
if $PURGE; then
    step "Purging data"

    warn "About to delete:"
    warn "  - Qdrant container and persistent volume"
    warn "  - All Redis data"
    warn "  - Ollama model cache will be preserved (delete manually if needed)"
    echo ""
    read -p "Are you sure? Type 'yes' to continue: " confirm
    if [[ "$confirm" != "yes" ]]; then
        info "Purge cancelled"
        exit 0
    fi

    # Need Colima up to remove the container cleanly
    if ! colima status 2>/dev/null | grep -q "Running"; then
        info "Starting Colima briefly to clean up container..."
        colima start
        sleep 5
    fi

    # Qdrant
    if docker ps -a --format '{{.Names}}' | grep -q '^qdrant$'; then
        docker rm qdrant >/dev/null
        info "Qdrant container removed"
    fi
    rm -rf "$HOME/qms-agent-data/qdrant"
    info "Qdrant data deleted"

    # Stop Colima again after cleanup
    colima stop

    # Redis - flush keys
    brew services start redis >/dev/null
    sleep 1
    redis-cli FLUSHALL >/dev/null
    brew services stop redis >/dev/null
    info "Redis data flushed"

    info "Purge complete. To also remove Ollama models, run:"
    info "  ollama rm qwen2.5:7b-instruct-q4_K_M mxbai-embed-large"
fi

echo ""
echo -e "${GREEN}Teardown complete.${NC}"