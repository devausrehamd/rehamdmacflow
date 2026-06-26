#!/usr/bin/env bash
# setup.sh - Bring up the local QMS Agent stack on macOS.
#
# Idempotent: safe to re-run. Will skip steps that are already done.
# At completion the system is fully running: services started, database
# created, migrations applied, npm packages installed, .env configured.

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

# Ensures psql is reachable on PATH, handling versioned formulae that
# don't auto-link. Idempotent.
ensure_postgres_linked() {
    if command -v psql >/dev/null 2>&1; then
        return 0
    fi

    info "psql not on PATH; attempting to link..."

    for v in postgresql@17 postgresql@16 postgresql@18; do
        if brew list "$v" >/dev/null 2>&1; then
            info "Found $v installed; linking..."
            brew link --force --overwrite "$v" 2>/dev/null || true
            break
        fi
    done

    if ! command -v psql >/dev/null 2>&1; then
        fail "Could not link Postgres. Run 'brew link --force postgresql@17' manually."
    fi
    info "psql linked: $(psql --version)"
}

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
if ! command -v node >/dev/null 2>&1; then
    fail "Node.js is not on PATH. Install nvm (https://github.com/nvm-sh/nvm) and run 'nvm use' in this directory."
fi

NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')
if [[ $NODE_MAJOR -ne 22 ]]; then
    warn "Node version is $(node --version), but this project requires Node 22 LTS."
    warn "Known compatibility issues with Node 25+ and @qdrant/js-client-rest."
    if [[ -f .nvmrc ]] && command -v nvm >/dev/null 2>&1; then
        warn "Run 'nvm use' to switch to the version pinned in .nvmrc."
    fi
    warn "Continuing anyway."
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

if brew services list | grep -q "^postgresql@17.*started"; then
    info "Postgres already running"
else
    brew services start postgresql@17
    info "Postgres started"
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

# Step 6: Postgres database setup
step "Setting up Postgres database and user"

ensure_postgres_linked

if ! wait_for "Postgres" "psql postgres -c 'SELECT 1' -t" 30; then
    fail "Postgres started but psql cannot connect after 30s. Check 'brew services list'."
fi
info "Postgres reachable"

# Read the password from .env if available, otherwise use a default
POSTGRES_PASSWORD_FROM_ENV="changeme"
if [[ -f .env ]]; then
    ENV_PG_PASS=$(grep -E '^POSTGRES_PASSWORD=' .env | head -1 | cut -d'=' -f2- || echo "")
    if [[ -n "$ENV_PG_PASS" ]]; then
        POSTGRES_PASSWORD_FROM_ENV="$ENV_PG_PASS"
    fi
fi

# Create user if not exists (psql DO block is idempotent)
psql postgres -t -c "DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qms_agent') THEN
        CREATE USER qms_agent WITH PASSWORD '$POSTGRES_PASSWORD_FROM_ENV';
        RAISE NOTICE 'User qms_agent created';
    ELSE
        ALTER USER qms_agent WITH PASSWORD '$POSTGRES_PASSWORD_FROM_ENV';
        RAISE NOTICE 'User qms_agent password updated';
    END IF;
END \$\$;" 2>&1 | grep -v "^$" | sed 's/^/    /'

# Create database if not exists
DB_EXISTS=$(psql postgres -t -c "SELECT 1 FROM pg_database WHERE datname = 'qms_agent'" | tr -d ' ' || echo "")
if [[ "$DB_EXISTS" == "1" ]]; then
    info "Database 'qms_agent' already exists"
else
    psql postgres -c "CREATE DATABASE qms_agent OWNER qms_agent" >/dev/null
    info "Database 'qms_agent' created"
fi

psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE qms_agent TO qms_agent" >/dev/null
info "Privileges granted"

# Read-only role for the data query API
READONLY_PASS="changeme_readonly"
if [[ -f .env ]]; then
    ENV_RO_PASS=$(grep -E '^POSTGRES_READONLY_PASSWORD=' .env | head -1 | cut -d'=' -f2- || echo "")
    if [[ -n "$ENV_RO_PASS" ]]; then
        READONLY_PASS="$ENV_RO_PASS"
    fi
fi

psql postgres -t -c "DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qms_readonly') THEN
        CREATE USER qms_readonly WITH PASSWORD '$READONLY_PASS';
        RAISE NOTICE 'Read-only role qms_readonly created';
    ELSE
        ALTER USER qms_readonly WITH PASSWORD '$READONLY_PASS';
    END IF;
END \$\$;" 2>&1 | grep -v "^$" | sed 's/^/    /'

# Grant SELECT-only on the qms_agent database. ALTER DEFAULT PRIVILEGES
# ensures future tables (the UUID data tables created at ingest time) are
# also readable by the read-only role without re-granting each time.
psql -d qms_agent -c "GRANT CONNECT ON DATABASE qms_agent TO qms_readonly" >/dev/null 2>&1 || true
psql -d qms_agent -c "GRANT USAGE ON SCHEMA public TO qms_readonly" >/dev/null 2>&1 || true
psql -d qms_agent -c "GRANT SELECT ON ALL TABLES IN SCHEMA public TO qms_readonly" >/dev/null 2>&1 || true
psql -d qms_agent -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO qms_readonly" >/dev/null 2>&1 || true
info "Read-only role configured with SELECT-only access"

# Step 7: Project dependencies
step "Installing Node project dependencies"

if [[ -f package.json ]]; then
    npm install
    info "npm install complete"
else
    warn "No package.json in current directory."
fi

# Step 8: Environment file
step "Environment configuration"

if [[ -f .env ]]; then
    info ".env already exists; not overwriting"

    # Check for required keys that may have been added in later versions of .env.example
    REQUIRED_KEYS=("POSTGRES_HOST" "POSTGRES_USER" "POSTGRES_PASSWORD" "POSTGRES_DATABASE" "JWT_SECRET" "API_PORT")
    MISSING_KEYS=()
    for key in "${REQUIRED_KEYS[@]}"; do
        if ! grep -q "^${key}=" .env; then
            MISSING_KEYS+=("$key")
        fi
    done

    if [[ ${#MISSING_KEYS[@]} -gt 0 ]]; then
        warn ".env is missing required keys: ${MISSING_KEYS[*]}"
        warn "Append them from .env.example, then re-run this script."
        warn "  Example: tail -n +20 .env.example >> .env"
        exit 1
    fi
elif [[ -f .env.example ]]; then
    cp .env.example .env
    info ".env created from .env.example"

    # Generate and inject a JWT secret if it's still the placeholder
    if grep -q "replace-me-with-a-32-char-or-longer-random-string" .env; then
        SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        # Use a delimiter unlikely to appear in the value
        sed -i.bak "s|JWT_SECRET=.*|JWT_SECRET=$SECRET|" .env
        rm .env.bak
        info "Generated fresh JWT_SECRET in .env"
    fi
else
    warn "Neither .env nor .env.example found; you will need to create .env manually"
fi

# Step 9: Apply database migrations
step "Applying database migrations"

if [[ -f drizzle.config.ts && -d drizzle && -d node_modules ]]; then
    # Drizzle-kit needs meta/_journal.json to track migration state.
    # If it doesn't exist, create it bootstrapped with all SQL files in drizzle/
    if [[ ! -f drizzle/meta/_journal.json ]]; then
        info "Creating drizzle/meta/_journal.json bootstrap..."
        mkdir -p drizzle/meta
        ENTRIES=""
        IDX=0
        for sql_file in drizzle/[0-9]*_*.sql; do
            [[ -e "$sql_file" ]] || continue
            TAG=$(basename "$sql_file" .sql)
            if [[ -n "$ENTRIES" ]]; then ENTRIES+=","; fi
            ENTRIES+="{\"idx\":$IDX,\"version\":\"7\",\"when\":$(($(date +%s)*1000)),\"tag\":\"$TAG\",\"breakpoints\":true}"
            IDX=$((IDX+1))
        done
        echo "{\"version\":\"7\",\"dialect\":\"postgresql\",\"entries\":[$ENTRIES]}" > drizzle/meta/_journal.json
    fi

    npm run db:migrate
    info "Migrations applied"
else
    warn "Drizzle config or migrations folder missing; skipping. Run 'npm run db:migrate' once everything is in place."
fi

# Step 10: Verify
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
verify "Ollama API"     "curl -sf http://localhost:11434/api/tags"                                                  || ALL_OK=false
verify "Qdrant API"     "curl -sf http://localhost:6333/"                                                          || ALL_OK=false
verify "Redis"          "redis-cli ping | grep -q PONG"                                                            || ALL_OK=false
verify "Postgres"       "psql -U qms_agent -d qms_agent -c 'SELECT 1' -t"                                          || ALL_OK=false
verify "Colima/Docker"  "docker info"                                                                              || ALL_OK=false
verify "Node 22"        "test \"\$(node -e 'process.stdout.write(process.versions.node.split(\".\")[0])')\" = '22'" || ALL_OK=false
verify "npm"            "npm --version"                                                                            || ALL_OK=false
verify "Schema tables"  "psql -U qms_agent -d qms_agent -c '\\dt users' | grep -q 'users'"                          || ALL_OK=false

echo ""

if $ALL_OK; then
    echo -e "${GREEN}Setup complete. System is fully running.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Verify the data plane: npm run smoke:dataplane"
    echo "  2. Ingest QMS documents:  npm run ingest:repo"
    echo "  3. Query the RAG:         npm run ask -- 'your question'"
    echo ""
    echo "Service URLs:"
    echo "  Ollama:    http://localhost:11434"
    echo "  Qdrant:    http://localhost:6333  (dashboard: /dashboard)"
    echo "  Redis:     localhost:6379"
    echo "  Postgres:  localhost:5432  (database: qms_agent)"
else
    echo -e "${RED}Setup completed with errors.${NC} See failed checks above."
    exit 1
fi