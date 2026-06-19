#!/usr/bin/env bash
# health.sh — Check the state of all local services for the QMS Agent.
#
# Usage:
#   ./health.sh

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()    { echo -e "  ${GREEN}✓${NC} $1"; }
fail()  { echo -e "  ${RED}✗${NC} $1"; }
info()  { echo -e "  $1"; }
heading() { echo -e "\n${BLUE}$1${NC}"; }

OVERALL=0

# --- Ollama ---
heading "Ollama"
if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "API reachable on :11434"
    MODELS=$(curl -s http://localhost:11434/api/tags | grep -oE '"name":"[^"]+"' | wc -l | tr -d ' ')
    info "Models available: $MODELS"
    if ollama list 2>/dev/null | grep -q "qwen2.5:7b-instruct-q4_K_M"; then
        ok "qwen2.5:7b-instruct-q4_K_M pulled"
    else
        fail "qwen2.5:7b-instruct-q4_K_M NOT pulled"
        OVERALL=1
    fi
    if ollama list 2>/dev/null | grep -q "mxbai-embed-large"; then
        ok "mxbai-embed-large pulled"
    else
        fail "mxbai-embed-large NOT pulled"
        OVERALL=1
    fi
else
    fail "API not reachable. Try: brew services start ollama"
    OVERALL=1
fi

# --- Qdrant ---
heading "Qdrant"
if curl -sf http://localhost:6333/ >/dev/null 2>&1; then
    ok "API reachable on :6333"
    if curl -sf "http://localhost:6333/collections/qms_documents" >/dev/null 2>&1; then
        COUNT=$(curl -s "http://localhost:6333/collections/qms_documents" | grep -oE '"points_count":[0-9]+' | head -1 | grep -oE '[0-9]+')
        ok "Collection qms_documents exists (${COUNT:-0} points)"
    else
        fail "Collection qms_documents does not exist. Run: npm run ingest"
        OVERALL=1
    fi
else
    fail "API not reachable. Try: docker start qdrant"
    OVERALL=1
fi

# --- Redis ---
heading "Redis"
if redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "Responding to PING"
    KEYS=$(redis-cli DBSIZE 2>/dev/null | grep -oE '[0-9]+')
    info "Keys in db: ${KEYS:-0}"
else
    fail "Not responding. Try: brew services start redis"
    OVERALL=1
fi

# --- Project ---
heading "Project"
if [[ -f .env ]]; then
    ok ".env exists"
    if grep -q "CHANGE_ME" .env 2>/dev/null; then
        fail ".env contains CHANGE_ME — edit QMS_FOLDER before running the agent"
        OVERALL=1
    fi
else
    fail ".env missing. Run: cp .env.example .env  (then edit it)"
    OVERALL=1
fi

if [[ -d node_modules ]]; then
    ok "node_modules present"
else
    fail "node_modules missing. Run: npm install"
    OVERALL=1
fi

# --- Summary ---
echo ""
if [[ $OVERALL -eq 0 ]]; then
    echo -e "${GREEN}All systems healthy.${NC}"
else
    echo -e "${YELLOW}Some checks failed — see above.${NC}"
    exit 1
fi