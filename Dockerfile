# Agent image for the operational control plane (docs/specs/SPEC-operational-control-plane.md, D0).
#
# ONE image; the ROLE is chosen at boot by QMS_MANIFEST (e.g. agents/researcher.json).
# The repo has no JS build step — it runs via tsx — so the full dependency set
# (tsx is a dev dependency) is installed and the source is run directly.
FROM node:22-slim

# git lets the agent read its code/config commit for the Agent Card. Without a
# .git in the image it falls back to "uncommitted" (best-effort provenance), so
# this is a nicety, not a requirement. ca-certificates for outbound TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, for layer caching. Do NOT omit dev deps — tsx runs the app.
# --legacy-peer-deps: the LangChain ecosystem mismatches peers (see readme.md
# troubleshooting), which is how the host installs too.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --legacy-peer-deps

# App source. .dockerignore keeps node_modules/.git/.env/logs out of the image,
# so no host secrets or localhost URLs are baked in; all config arrives via env.
COPY . .

# The in-container API port. The launcher maps it to a host port and sets
# QMS_AGENT_ADDRESS to the address it advertises to Discovery.
ENV API_PORT=4000
EXPOSE 4000

# The role is selected at run time:  -e QMS_MANIFEST=/app/agents/researcher.json
CMD ["npm", "run", "api"]
