#!/usr/bin/env bash
#
# D0 smoke (operational control plane, SPEC-operational-control-plane.md).
#
# Builds the agent image, runs it as a RESEARCHER (role chosen by QMS_MANIFEST),
# and proves the container boots, answers /health, and self-registers with
# Discovery advertising exactly its role capability (research:qms) — settling the
# container -> host networking before the launcher is built on top.
#
# Needs: Colima/Docker running, Discovery on :3005, and the host .env (its service
# URLs are rewritten to host.docker.internal for the container). No launcher yet.
#
# Usage: npm run smoke:d0

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="qms-agent:d0"
NAME="qms-d0-researcher"
PORT="${QMS_D0_PORT:-4200}"
DISCOVERY="${QMS_DISCOVERY_URL:-http://localhost:3005}"
GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; NC=$'\033[0m'
fail=0
ok()   { echo "${GREEN}OK${NC}   $1"; }
bad()  { echo "${RED}FAIL${NC} $1"; fail=$((fail+1)); }

ENVFILE="$(mktemp)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -f "$ENVFILE" 2>/dev/null || true; }
trap cleanup EXIT

echo "=== D0: agent container registers as a researcher ==="

# 0. Preconditions
docker info >/dev/null 2>&1 || { echo "Docker/Colima not running"; exit 1; }
curl -sf "$DISCOVERY/v1/agents" >/dev/null 2>&1 || { echo "Discovery not reachable at $DISCOVERY"; exit 1; }

# 1. Build the image
echo "  building image (first run pulls node + npm ci; can take a few minutes)…"
docker build -q -t "$IMAGE" "$ROOT" >/dev/null

# 2. Env: the host .env with localhost -> host.docker.internal, plus D0 overrides.
if [ -f "$ROOT/.env" ]; then
  sed -E 's#(localhost|127\.0\.0\.1)#host.docker.internal#g' "$ROOT/.env" > "$ENVFILE"
fi
cat >> "$ENVFILE" <<EOF
QMS_MANIFEST=/app/agents/researcher.json
QMS_DISCOVERY_URL=http://host.docker.internal:3005
QMS_AGENT_ADDRESS=http://localhost:${PORT}
QMS_AGENT_NAME=qms-researcher-d0
QMS_AGENT_GROUP=qms-researcher-d0
QMS_AGENT_GUID_FILE=/tmp/agent-guid.txt
API_PORT=4000
EOF

# 3. Run the container
docker run -d --name "$NAME" -p "${PORT}:4000" --env-file "$ENVFILE" "$IMAGE" >/dev/null
ok "container started ($NAME on :$PORT)"

# 4. Wait for /health from the host
t=0; healthy=""
until [ -n "$healthy" ] || [ "$t" -ge 60 ]; do
  curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1 && healthy=1 || { sleep 2; t=$((t+2)); }
done
[ -n "$healthy" ] && ok "answers /health from the host (${t}s)" || bad "never became healthy — logs:$(docker logs --tail 15 "$NAME" 2>&1)"

# 5. Self-registered with Discovery advertising research:qms
t=0; card=""
until [ -n "$card" ] || [ "$t" -ge 40 ]; do
  card="$(curl -sf "$DISCOVERY/v1/agents" 2>/dev/null | tr -d ' \n' | grep -o '{[^{}]*qms-researcher-d0[^{}]*}' || true)"
  [ -n "$card" ] || { sleep 2; t=$((t+2)); }
done
if [ -n "$card" ]; then
  ok "registered with Discovery (${t}s)"
  echo "$card" | grep -q 'research:qms' && ok "  advertises the role capability research:qms" \
    || bad "  did not advertise research:qms — card: $card"
  echo "$card" | grep -q '"health":"healthy"' && ok "  Discovery reports it healthy" || echo "     (health field not yet 'healthy' — non-fatal)"
else
  bad "did not appear in Discovery — logs:$(docker logs --tail 15 "$NAME" 2>&1)"
fi

echo ""
if [ "$fail" -eq 0 ]; then echo "${GREEN}D0 is sound — the container is a real, registered researcher.${NC}"; else echo "${RED}${fail} check(s) failed.${NC}"; fi
exit "$fail"
