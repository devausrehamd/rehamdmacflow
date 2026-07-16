#!/usr/bin/env bash
# Live discovery check. Run with Discovery AND the Agent both up.
# Proves the Agent actually registered - the discovery equivalent of the auth
# handshake. Curl-level, so a failure is a registration bug, not a GUI bug.
#
# Usage: ./live-check.sh

DISCOVERY="${DISCOVERY_URL:-http://localhost:3005}"

echo "1. Discovery reachable on $DISCOVERY ?"
HCODE=$(curl -s -o /tmp/disc-health.json -w "%{http_code}" "$DISCOVERY/health" 2>/dev/null || echo "000")
if [ "$HCODE" != "200" ]; then
  echo "   FAIL: Discovery not responding (HTTP $HCODE). Start it: npm run dev in discovery/ (:3005)"
  exit 1
fi
echo "   OK: Discovery up ($(cat /tmp/disc-health.json))"

echo "2. Which agents are registered?"
curl -s "$DISCOVERY/v1/agents" -o /tmp/disc-agents.json 2>/dev/null
COUNT=$(sed -n 's/.*"guid"/&/gp' /tmp/disc-agents.json | grep -o '"guid"' | wc -l | tr -d ' ')
if [ "$COUNT" = "0" ]; then
  echo "   NONE registered yet."
  echo "   -> Is the Agent running WITH discovery configured?"
  echo "      The Agent needs these in its .env:"
  echo "        QMS_DISCOVERY_URL=http://localhost:3005"
  echo "        QMS_AGENT_NAME=Production DFMEA"
  echo "        QMS_AGENT_ADDRESS=http://localhost:4000"
  echo "      and it must have been (re)started AFTER adding them."
  exit 1
fi
echo "   OK: $COUNT agent(s) registered:"
# pretty-print the essentials
if command -v json_pp >/dev/null 2>&1; then
  cat /tmp/disc-agents.json | json_pp
else
  cat /tmp/disc-agents.json
fi

echo ""
echo "Discovery live-check complete: the Agent registered and is listed."
echo "The GUI's agent picker can now populate from GET $DISCOVERY/v1/agents"