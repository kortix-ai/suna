#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Kortix — One-Click Install                                               ║
# ║                                                                            ║
# ║  curl -fsSL https://kortix.com/install | bash                              ║
# ║                                                                            ║
# ║  Supports two modes (same stack, different bind address):                  ║
# ║    1. Local (laptop/desktop) — binds to 127.0.0.1                          ║
# ║    2. VPS / Server           — binds to 0.0.0.0 (world-accessible)        ║
# ║                                                                            ║
# ║  No reverse proxy included. Bring your own Caddy/nginx/Cloudflare if      ║
# ║  you want HTTPS.                                                           ║
# ║                                                                            ║
# ║  Database: Docker Supabase or external (bring your own).                   ║
# ║                                                                            ║
# ║  Requirement: Docker + Docker Compose v2.                                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

set -euo pipefail

# ─── Color Palette ────────────────────────────────────────────────────────────
RED='\033[0;31m'        # Error / fatal
GREEN='\033[0;32m'      # Success / done
YELLOW='\033[1;33m'     # Warning / attention
CYAN='\033[0;36m'       # Brand accent
WHITE='\033[1;37m'      # Emphasis
BOLD='\033[1m'
DIM='\033[2m'
FADED='\033[2;37m'      # Muted text
NC='\033[0m'            # Reset

# ─── Modern Output Functions ───────────────────────────────────────────────────
# Using %b so embedded \033 escape codes in arguments render correctly.

info()    { printf "    ${CYAN}▸${NC}  %b\n" "$*"; }
success() { printf "    ${GREEN}✓${NC}  %b\n" "$*"; }
warn()    { printf "    ${YELLOW}!${NC}  ${YELLOW}%b${NC}\n" "$*"; }
error()   { printf "    ${RED}✗${NC}  ${RED}%b${NC}\n" "$*" >&2; }
fatal()   { error "$*"; exit 1; }

# Section header — bold line with title
section() {
  local title="$1"
  printf "\n"
  printf "  ${WHITE}${BOLD}%s${NC}\n" "$title"
  printf "  ${FADED}%s${NC}\n" "────────────────────────────────────────────────"
}

# Subsection — lighter divider
subsection() {
  printf "\n  ${FADED}── %s ──${NC}\n" "$*"
}

# Horizontal rule
hr() {
  printf "  ${FADED}%s${NC}\n" "────────────────────────────────────────────────"
}

# Progress dots (non-blocking visual feedback)
dots() {
  local label="$1"
  printf "    ${CYAN}▸${NC}  %s " "$label"
}
dots_done() { printf "${GREEN}done${NC}\n"; }
dots_ok()   { printf "${GREEN}✓${NC}\n"; }

# ─── Config ──────────────────────────────────────────────────────────────────
INSTALL_DIR="${KORTIX_HOME:-$HOME/.kortix}"

# Resolve the latest released version from GitHub Releases API.
# Falls back to the 'latest' Docker tag if the API is unreachable.
resolve_latest_version() {
  local gh_version
  gh_version=$(curl_with_retry -sf --connect-timeout 5 \
    "https://api.github.com/repos/kortix-ai/suna/releases/latest" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' 2>/dev/null) || true
  if [ -n "$gh_version" ]; then
    printf '%s' "$gh_version"
    return
  fi

  # Last resort: use the 'latest' Docker tag
  printf 'latest'
}

# Allow explicit override via env var or --version flag; otherwise leave empty
# and resolve dynamically after parse_args
KORTIX_VERSION="${KORTIX_VERSION:-}"
KORTIX_LOCAL_IMAGES="${KORTIX_LOCAL_IMAGES:-0}"
KORTIX_LOCAL_TAG="${KORTIX_LOCAL_TAG:-latest}"
KORTIX_BUILD_LOCAL_IMAGES="${KORTIX_BUILD_LOCAL_IMAGES:-0}"
KORTIX_PULL_PARALLELISM="${KORTIX_PULL_PARALLELISM:-4}"
KORTIX_NETWORK_RETRIES="${KORTIX_NETWORK_RETRIES:-3}"
KORTIX_NETWORK_RETRY_DELAY="${KORTIX_NETWORK_RETRY_DELAY:-2}"
KORTIX_REGISTRY_PREFLIGHT_IMAGE="${KORTIX_REGISTRY_PREFLIGHT_IMAGE:-kortix/computer:latest}"

run_with_retry() {
  local attempts="$1" delay="$2"
  shift 2

  local attempt=1
  local status=0
  while true; do
    if "$@"; then
      return 0
    fi
    status=$?
    if [ "$attempt" -ge "$attempts" ]; then
      return "$status"
    fi
    attempt=$((attempt + 1))
    sleep "$delay"
  done
}

curl_with_retry() {
  run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" curl "$@"
}

# Always prefer /dev/tty for interactive reads — critical for
# `curl URL | bash` where stdin is the pipe, not the terminal.
TTY_AVAILABLE="0"
if [ -r /dev/tty ] && [ -w /dev/tty ]; then
  TTY_AVAILABLE="1"
fi
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
REPO_ROOT=""
if [ -n "$SCRIPT_SOURCE" ] && [ "$SCRIPT_SOURCE" != "bash" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
KORTIX_LOCAL_REPO_ROOT="${KORTIX_LOCAL_REPO_ROOT:-$REPO_ROOT}"

resolve_node_bin() {
  local nvm_latest
  nvm_latest=$(ls -1dt "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | head -1 || true)
  if [ -n "$nvm_latest" ] && [ -x "$nvm_latest" ]; then
    printf '%s' "$nvm_latest"
    return
  fi
  command -v node
}

NODE_BIN="$(resolve_node_bin || true)"
PNPM_BIN="$(command -v pnpm || true)"
BUN_BIN="$(command -v bun || true)"

compute_compose_project_name() {
  local raw
  raw="$(basename "$INSTALL_DIR")"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed 's/^[._-]*//; s/[^a-z0-9_-]//g')"
  [ -n "$raw" ] || raw="kortix"
  printf '%s' "$raw"
}

COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(compute_compose_project_name)}"
SANDBOX_NETWORK="${SANDBOX_NETWORK:-${COMPOSE_PROJECT_NAME}_default}"

parse_query_param() {
  local raw="$1"
  local qs="${raw#*\?}"
  IFS='&' read -r -a pairs <<< "$qs"
  for pair in "${pairs[@]}"; do
    local key="${pair%%=*}"
    local value="${pair#*=}"
    case "$key" in
      v|version|tag)
        [ -n "$value" ] && KORTIX_VERSION="$value"
        ;;
    esac
  done
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --local)
        KORTIX_LOCAL_IMAGES=1
        shift
        ;;
      --build-local)
        KORTIX_LOCAL_IMAGES=1
        KORTIX_BUILD_LOCAL_IMAGES=1
        shift
        ;;
      --local-tag)
        [ "$#" -ge 2 ] || fatal "--local-tag requires a value"
        KORTIX_LOCAL_IMAGES=1
        KORTIX_LOCAL_TAG="$2"
        shift 2
        ;;
      --local-tag=*)
        KORTIX_LOCAL_IMAGES=1
        KORTIX_LOCAL_TAG="${1#*=}"
        shift
        ;;
      --version)
        [ "$#" -ge 2 ] || fatal "--version requires a value"
        KORTIX_VERSION="$2"
        shift 2
        ;;
      --version=*)
        KORTIX_VERSION="${1#*=}"
        shift
        ;;
      --query)
        [ "$#" -ge 2 ] || fatal "--query requires a value"
        parse_query_param "$2"
        shift 2
        ;;
      --query=*)
        parse_query_param "${1#*=}"
        shift
        ;;
      \?*|*'?'*)
        parse_query_param "$1"
        shift
        ;;
      -h|--help)
        cat <<'EOF'
Usage: get-kortix.sh [options]

Options:
  --local             Use local Docker images instead of pulling from registry
  --build-local       Rebuild local installer images before starting
  --local-tag <tag>   Local image tag to use (default: latest)
  --local-tag=<tag>   Same as above
  --version <tag>     Install a specific image tag (default: current stable release)
  --version=<tag>     Same as above
  --query "v=<tag>"   Query-style version override
  --query "version=<tag>"

Environment:
  KORTIX_VERSION=<tag>           Install a specific release tag
  KORTIX_PULL_PARALLELISM=<n>    Concurrent docker pulls (default: 4)
  KORTIX_NETWORK_RETRIES=<n>     External curl/docker pull retries (default: 3)
  KORTIX_NETWORK_RETRY_DELAY=<s> Seconds between retries (default: 2)
  KORTIX_REGISTRY_PREFLIGHT_IMAGE
                                 Image used for registry reachability probe

Examples:
  bash get-kortix.sh
  bash get-kortix.sh --local
  bash get-kortix.sh --local --build-local
  bash get-kortix.sh --local --local-tag latest
  bash get-kortix.sh --version 0.7.14
  bash get-kortix.sh --query "v=0.7.14"
  KORTIX_VERSION=0.7.15 bash get-kortix.sh
  KORTIX_PULL_PARALLELISM=1 bash get-kortix.sh
EOF
        exit 0
        ;;
      *)
        fatal "Unknown option: $1"
        ;;
    esac
  done
}

parse_args "$@"

# If version wasn't explicitly set, resolve the latest from GitHub Releases API.
if [ -z "$KORTIX_VERSION" ] && [ "$KORTIX_LOCAL_IMAGES" != "1" ]; then
  KORTIX_VERSION=$(resolve_latest_version)
fi
# Ensure KORTIX_VERSION always has a value (fallback to 'latest' tag)
KORTIX_VERSION="${KORTIX_VERSION:-latest}"

IMAGE_TAG="$KORTIX_VERSION"
SANDBOX_IMAGE_REPO="kortix/computer"
if [ "$KORTIX_LOCAL_IMAGES" = "1" ]; then
  IMAGE_TAG="$KORTIX_LOCAL_TAG"
  SANDBOX_IMAGE_REPO="kortix/computer"
fi

FRONTEND_IMAGE="${KORTIX_FRONTEND_IMAGE:-kortix/kortix-frontend:${IMAGE_TAG}}"
API_IMAGE="${KORTIX_API_IMAGE:-kortix/kortix-api:${IMAGE_TAG}}"
SANDBOX_IMAGE="${KORTIX_SANDBOX_IMAGE:-${SANDBOX_IMAGE_REPO}:${IMAGE_TAG}}"
FRONTEND_IMAGE_OVERRIDDEN="0"
API_IMAGE_OVERRIDDEN="0"
SANDBOX_IMAGE_OVERRIDDEN="0"
[ -n "${KORTIX_FRONTEND_IMAGE:-}" ] && FRONTEND_IMAGE_OVERRIDDEN="1"
[ -n "${KORTIX_API_IMAGE:-}" ] && API_IMAGE_OVERRIDDEN="1"
[ -n "${KORTIX_SANDBOX_IMAGE:-}" ] && SANDBOX_IMAGE_OVERRIDDEN="1"
SUPABASE_POSTGRES_IMAGE="supabase/postgres:15.8.1.085"
SUPABASE_GOTRUE_IMAGE="supabase/gotrue:v2.186.0"
SUPABASE_KONG_IMAGE="kong:2.8.1"
SUPABASE_REST_IMAGE="postgrest/postgrest:v14.5"

# ─── Self-hosted sandbox isolation ────────────────────────────────────────────
# Different name + port range from dev (kortix-sandbox / 14000) so both can
# run simultaneously on the same Docker daemon.
SANDBOX_CONTAINER_NAME="${SANDBOX_CONTAINER_NAME:-kortix-hosted-sandbox}"
SANDBOX_PORT_BASE="${SANDBOX_PORT_BASE:-15000}"

# Installer state
DEPLOY_MODE=""          # "local" or "vps"
DB_MODE=""              # "docker" or "external"
SERVER_IP=""


# Supabase — generated for docker mode, provided for external
SUPABASE_URL=""
SUPABASE_ANON_KEY=""
SUPABASE_SERVICE_ROLE_KEY=""
SUPABASE_JWT_SECRET=""
DATABASE_URL=""
POSTGRES_PASSWORD=""

# Generated secrets
CRON_SECRET=""
INTERNAL_SERVICE_KEY=""

# Computed URLs
PUBLIC_URL=""
API_PUBLIC_URL=""

# Optional integrations
INTEGRATION_AUTH_PROVIDER="disabled"
PIPEDREAM_CLIENT_ID=""
PIPEDREAM_CLIENT_SECRET=""
PIPEDREAM_PROJECT_ID=""
PIPEDREAM_ENVIRONMENT=""
SLACK_CLIENT_ID=""
SLACK_CLIENT_SECRET=""
SLACK_SIGNING_SECRET=""

# ─── Helpers ─────────────────────────────────────────────────────────────────
open_browser() {
  local url="$1"
  if command -v open &>/dev/null; then open "$url" 2>/dev/null || true
  elif command -v xdg-open &>/dev/null; then xdg-open "$url" 2>/dev/null || true
  elif command -v wslview &>/dev/null; then wslview "$url" 2>/dev/null || true
  fi
}

prompt_read() {
  local __var_name="$1"
  if [ "$TTY_AVAILABLE" = "1" ]; then
    IFS= read -r "$__var_name" </dev/tty
  else
    IFS= read -r "$__var_name"
  fi
}

docker_pull_with_retry() {
  local image="$1"
  run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" docker pull "$image"
}

wait_for_http_ready() {
  local url="$1"
  local label="$2"
  local max_attempts="${3:-30}"
  local attempts=0

  printf "    ${CYAN}▸${NC}  Waiting for %s " "$label"
  while [ "$attempts" -lt "$max_attempts" ]; do
    if curl -sf "$url" >/dev/null 2>&1; then
      printf " ${GREEN}✓${NC}\n"
      return 0
    fi
    printf "${FADED}.${NC}"
    sleep 2
    attempts=$((attempts + 1))
  done

  printf " ${YELLOW}timeout${NC}\n"
  return 1
}

warm_local_sandbox() {
  [ "$DEPLOY_MODE" = "local" ] || return 0

  local warm_url="${API_PUBLIC_URL}/v1/setup/local-sandbox/warm"
  local status_url="${API_PUBLIC_URL}/v1/setup/local-sandbox/warm/status"

  dots "Pre-warming sandbox"
  curl -sf -X POST "$warm_url" >/dev/null || {
    printf "${YELLOW}skipped${NC}\n"
    printf "    ${FADED}Onboarding will start the sandbox lazily.${NC}\n"
    return 0
  }

  local attempts=0
  local max_attempts=180
  while [ $attempts -lt $max_attempts ]; do
    local payload status progress message
    payload=$(curl -sf "$status_url" 2>/dev/null || true)
    status=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("status", ""))')
    progress=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("progress", ""))')
    message=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("message", ""))')

    case "$status" in
      ready)
        dots_done
        return 0
        ;;
      error)
        printf "${YELLOW}error${NC}\n"
        warn "Sandbox warmup: ${message:-unknown}"
        return 0
        ;;
      pulling|creating)
        printf "\r    ${CYAN}▸${NC}  Sandbox: ${message:-starting}${progress:+ (${progress}%%)}          "
        ;;
      *)
        printf "\r    ${CYAN}▸${NC}  Sandbox: bootstrapping...          "
        ;;
    esac

    sleep 2
    attempts=$((attempts + 1))
  done

  printf "\n"
  warn "Sandbox warmup timed out — the UI will continue waiting."
}

verify_local_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || fatal "Local image not found: ${image}. Build or tag it first, or run without --local."
}

ensure_local_build_requirements() {
  [ -d "$KORTIX_LOCAL_REPO_ROOT/apps/web" ] || fatal "Local repo root not found at ${KORTIX_LOCAL_REPO_ROOT}."
  [ -x "$PNPM_BIN" ] || fatal "pnpm is required for --build-local."
}

rebuild_local_images() {
  ensure_local_build_requirements
  local build_script="$KORTIX_LOCAL_REPO_ROOT/scripts/build-local-images.sh"
  [ -f "$build_script" ] || fatal "Local build script not found: ${build_script}"

  info "Rebuilding local installer images from ${KORTIX_LOCAL_REPO_ROOT}"
  echo ""
  bash "$build_script" --tag "$KORTIX_LOCAL_TAG"
  success "Local images rebuilt"
}

generate_password() {
  local seg1 seg2 seg3
  seg1=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  seg2=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  seg3=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 4)
  echo "kx-${seg1}-${seg2}-${seg3}"
}

generate_token() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

get_server_ip() {
  curl_with_retry -4 -sf --connect-timeout 5 https://ifconfig.me 2>/dev/null \
    || curl_with_retry -4 -sf --connect-timeout 5 https://api.ipify.org 2>/dev/null \
    || curl_with_retry -4 -sf --connect-timeout 5 https://icanhazip.com 2>/dev/null \
    || echo ""
}

get_host_docker_socket() {
  docker context inspect --format '{{ (index .Endpoints "docker").Host }}' 2>/dev/null || echo "${DOCKER_HOST:-}"
}

docker_manifest_exists() {
  local image="$1"
  # Check locally first, then Docker Hub registry
  docker image inspect "$image" >/dev/null 2>&1 && return 0
  run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" docker manifest inspect "$image" >/dev/null 2>&1
}

docker_registry_probe() {
  local image="$1"
  run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" docker manifest inspect "$image" >/dev/null 2>&1
}

resolve_release_images() {
  [ "$KORTIX_LOCAL_IMAGES" = "1" ] && return 0

  dots "Resolving images for v${KORTIX_VERSION}"

  if ! docker_manifest_exists "$FRONTEND_IMAGE"; then
    if [ "$FRONTEND_IMAGE_OVERRIDDEN" = "1" ]; then
      fatal "Configured frontend image not found: ${FRONTEND_IMAGE}"
    fi
    local fallback_frontend="kortix/kortix-frontend:latest"
    if docker_manifest_exists "$fallback_frontend"; then
      warn "Frontend image ${FRONTEND_IMAGE} not found; falling back to ${fallback_frontend}"
      FRONTEND_IMAGE="$fallback_frontend"
    else
      fatal "Frontend image not found for ${KORTIX_VERSION}, and latest fallback is unavailable."
    fi
  fi

  if ! docker_manifest_exists "$API_IMAGE"; then
    if [ "$API_IMAGE_OVERRIDDEN" = "1" ]; then
      fatal "Configured API image not found: ${API_IMAGE}"
    fi
    local fallback_api="kortix/kortix-api:latest"
    if docker_manifest_exists "$fallback_api"; then
      warn "API image ${API_IMAGE} not found; falling back to ${fallback_api}"
      API_IMAGE="$fallback_api"
    else
      fatal "API image not found for ${KORTIX_VERSION}, and latest fallback is unavailable."
    fi
  fi

  if ! docker_manifest_exists "$SANDBOX_IMAGE"; then
    if [ "$SANDBOX_IMAGE_OVERRIDDEN" = "1" ]; then
      fatal "Configured sandbox image not found: ${SANDBOX_IMAGE}"
    fi
    local fallback_sandbox="${SANDBOX_IMAGE_REPO}:latest"
    if docker_manifest_exists "$fallback_sandbox"; then
      warn "Sandbox image ${SANDBOX_IMAGE} not found; falling back to ${fallback_sandbox}"
      SANDBOX_IMAGE="$fallback_sandbox"
    else
      fatal "Sandbox image not found for ${KORTIX_VERSION}, and latest fallback is unavailable."
    fi
  fi

  dots_done
}

pull_images_parallel() {
  local -a images=("$@")
  [ ${#images[@]} -gt 0 ] || return 0

  export -f run_with_retry docker_pull_with_retry
  export KORTIX_NETWORK_RETRIES KORTIX_NETWORK_RETRY_DELAY
  printf '%s\n' "${images[@]}" | python3 -c 'import sys; print("\n".join(sorted(set(line.strip() for line in sys.stdin if line.strip()))))' \
    | xargs -r -I{} -P "$KORTIX_PULL_PARALLELISM" bash -c 'docker_pull_with_retry "$1"' _ "{}"
}

# Free ports used by Kortix (local mode)
# Usage: free_kortix_ports [project_name]
# If project_name is provided, only cleans containers from that project
free_kortix_ports() {
  local project_name="${1:-}"
  local is_local=0
  
  # Determine if we're in local mode
  if [ -n "$project_name" ]; then
    # Called from CLI with project name
    is_local=1
  elif [ "$DEPLOY_MODE" = "local" ]; then
    # Called during install
    is_local=1
  fi
  
  [ $is_local -eq 1 ] || return 0
  
  local ports=(13737 13738 13740 13741)
  local freed=0
  
  # First, clean up any lingering containers that might hold ports
  # Use project-specific pattern if project_name is provided
  if [ -n "$project_name" ]; then
    # Clean up containers from this compose project (e.g. kortix-frontend-1).
    # EXCLUDES standalone sandbox containers (kortix-sandbox, kortix-hosted-sandbox)
    # which are managed by the API, not compose — killing them breaks dev mode.
    docker ps -a --format '{{.Names}}' 2>/dev/null \
      | grep -E "^${project_name}-" \
      | grep -v -E "^(kortix-sandbox|kortix-hosted-sandbox)$" \
      | xargs -r docker rm -f 2>/dev/null || true
  fi
  
  # Kill any processes using the ports
  for port in "${ports[@]}"; do
    local pid
    pid=$(lsof -t -i:$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -9 $pid 2>/dev/null || true
      freed=1
    fi
  done
  
  [ $freed -eq 1 ] && info "Freed Kortix ports" || true
}

# Generate a Supabase JWT (anon or service_role)
# Usage: generate_supabase_jwt <role> <jwt_secret>
generate_supabase_jwt() {
  local role="$1" secret="$2"
  local header payload header_b64 payload_b64 signature
  header='{"alg":"HS256","typ":"JWT"}'
  # iat: 2022-01-01, exp: 2037-01-01 (same as Supabase defaults)
  payload="{\"role\":\"${role}\",\"iss\":\"supabase\",\"iat\":1641024000,\"exp\":2114380800}"

  header_b64=$(echo -n "$header" | base64 | tr '+/' '-_' | tr -d '=\n')
  payload_b64=$(echo -n "$payload" | base64 | tr '+/' '-_' | tr -d '=\n')
  signature=$(echo -n "${header_b64}.${payload_b64}" | openssl dgst -sha256 -hmac "$secret" -binary | base64 | tr '+/' '-_' | tr -d '=\n')

  echo "${header_b64}.${payload_b64}.${signature}"
}

# ─── Banner ──────────────────────────────────────────────────────────────────
banner() {
  printf "\n\n"
  printf "${CYAN}"
  cat << 'EOF'
    ██╗  ██╗ ██████╗ ██████╗ ████████╗██╗██╗  ██╗
    ██║ ██╔╝██╔═══██╗██╔══██╗╚══██╔══╝██║╚██╗██╔╝
    █████╔╝ ██║   ██║██████╔╝   ██║   ██║ ╚███╔╝ 
    ██╔═██╗ ██║   ██║██╔══██╗   ██║   ██║ ██╔██╗ 
    ██║  ██╗╚██████╔╝██║  ██║   ██║   ██║██╔╝ ██╗
    ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝
EOF
  printf "${NC}\n"
  printf "    ${WHITE}The Autonomous Company Operating System${NC}\n"
  printf "\n"
  printf "    ${FADED}v${KORTIX_VERSION}  ·  One-Click Installer  ·  Local or VPS${NC}\n"
  printf "\n"
}

# ─── Preflight ───────────────────────────────────────────────────────────────
preflight() {
  section "Checking prerequisites"

  command -v docker &>/dev/null || fatal "Docker is required — https://docs.docker.com/get-docker/"
  success "Docker installed"

  docker info &>/dev/null 2>&1 || fatal "Docker is not running. Start Docker Desktop and try again."
  success "Docker daemon running"

  docker compose version &>/dev/null 2>&1 || fatal "Docker Compose v2 required. Included with Docker Desktop."
  success "Docker Compose v2"

  command -v openssl &>/dev/null || fatal "openssl is required (for JWT generation)."
  success "openssl available"

  if [ "$KORTIX_LOCAL_IMAGES" != "1" ]; then
    dots "Checking Docker registry reachability"
    if docker_registry_probe "$KORTIX_REGISTRY_PREFLIGHT_IMAGE"; then
      dots_ok
    else
      printf "${RED}failed${NC}\n"
      fatal "Cannot reach Docker Hub for ${KORTIX_REGISTRY_PREFLIGHT_IMAGE}. Check DNS/network connectivity and retry."
    fi
  fi
  echo ""
}

# ─── Mode Selection ──────────────────────────────────────────────────────────
prompt_mode() {
  section "Where are you running Kortix?"

  printf "\n"
  printf "    ${WHITE}1)${NC}  Local machine   ${FADED}laptop / desktop — binds to localhost${NC}\n"
  printf "    ${WHITE}2)${NC}  VPS / Server     ${FADED}cloud VM — binds to 0.0.0.0${NC}\n"
  printf "\n"
  printf "    ${FADED}Select${NC} [${CYAN}1${NC}]: "
  prompt_read mode_choice

  case "${mode_choice:-1}" in
    2)
      DEPLOY_MODE="vps"
      SERVER_IP=$(get_server_ip)
      if [ -n "$SERVER_IP" ]; then
        success "Detected server IP: ${WHITE}${SERVER_IP}${NC}"
      else
        printf "\n    Enter server IP or hostname: "
        prompt_read SERVER_IP
        [ -z "$SERVER_IP" ] && fatal "Server IP is required for VPS mode."
      fi
      ;;
    *) DEPLOY_MODE="local" ;;
  esac

  echo ""
}

# ─── Database Setup ──────────────────────────────────────────────────────────
prompt_database() {
  section "Database"

  printf "\n"
  printf "    ${WHITE}1)${NC}  Docker ${FADED}(recommended)${NC}   ${FADED}auto-configure Supabase in Docker${NC}\n"
  printf "    ${WHITE}2)${NC}  External             ${FADED}bring your own Supabase project${NC}\n"
  printf "\n"
  printf "    ${FADED}Select${NC} [${CYAN}1${NC}]: "
  prompt_read db_choice

  case "${db_choice:-1}" in
    2)
      DB_MODE="external"
      subsection "Supabase Credentials"
      printf "    ${FADED}From your project: Settings → API${NC}\n\n"
      printf "    Supabase URL ${FADED}(https://xxx.supabase.co)${NC}: "
      prompt_read SUPABASE_URL
      printf "    Anon Key: "
      prompt_read SUPABASE_ANON_KEY
      printf "    Service Role Key: "
      prompt_read SUPABASE_SERVICE_ROLE_KEY
      printf "    JWT Secret: "
      prompt_read SUPABASE_JWT_SECRET
      printf "\n    ${FADED}From: Settings → Database → Connection string${NC}\n"
      printf "    Database URL ${FADED}(postgresql://...)${NC}: "
      prompt_read DATABASE_URL
      echo ""

      if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_ANON_KEY" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ] || [ -z "$DATABASE_URL" ]; then
        fatal "All Supabase credentials are required for external mode."
      fi

      success "External Supabase configured"
      ;;
    *)
      DB_MODE="docker"
      success "Supabase will run in Docker (auto-configured)"
      ;;
  esac

  echo ""
}



# ─── Integrations (Pipedream) ────────────────────────────────────────────────
# Pipedream creds are optional — the sandbox can send its own via request headers.
prompt_integrations() {
  INTEGRATION_AUTH_PROVIDER="pipedream"
}



# ─── Compute URLs ────────────────────────────────────────────────────────────
compute_urls() {
  if [ "$DEPLOY_MODE" = "vps" ]; then
    PUBLIC_URL="http://${SERVER_IP}:13737"
    API_PUBLIC_URL="http://${SERVER_IP}:13738"
  else
    PUBLIC_URL="http://localhost:13737"
    API_PUBLIC_URL="http://localhost:13738"
  fi
}

# ─── Generate Secrets ────────────────────────────────────────────────────────
generate_secrets() {
  dots "Generating secrets"
  
  CRON_SECRET=$(generate_password)
  INTERNAL_SERVICE_KEY=$(generate_token)
  API_KEY_SECRET=$(generate_token)
  TUNNEL_SIGNING_SECRET=$(generate_token)

  # Generate Supabase credentials for Docker mode
  if [ "$DB_MODE" = "docker" ]; then
    POSTGRES_PASSWORD=$(generate_token | head -c 32)
    SUPABASE_JWT_SECRET=$(generate_token)$(generate_token)  # 64 chars
    SUPABASE_ANON_KEY=$(generate_supabase_jwt "anon" "$SUPABASE_JWT_SECRET")
    SUPABASE_SERVICE_ROLE_KEY=$(generate_supabase_jwt "service_role" "$SUPABASE_JWT_SECRET")

    # Internal Supabase URL (kong gateway inside Docker network)
    SUPABASE_URL="http://supabase-kong:8000"
    DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@supabase-db:5432/postgres"
  fi

  dots_done
}



# ─── Write Kong Config ──────────────────────────────────────────────────────
write_kong_config() {
  [ "$DB_MODE" != "docker" ] && return

  mkdir -p "$INSTALL_DIR/volumes/api"
  cat > "$INSTALL_DIR/volumes/api/kong.yml" << 'KONGEOF'
_format_version: '2.1'
_transform: true

consumers:
  - username: anon
    keyauth_credentials:
      - key: $SUPABASE_ANON_KEY
  - username: service_role
    keyauth_credentials:
      - key: $SUPABASE_SERVICE_KEY

acls:
  - consumer: anon
    group: anon
  - consumer: service_role
    group: admin

services:
  ## Open Auth routes (no key required)
  - name: auth-v1-open
    url: http://supabase-auth:9999/verify
    routes:
      - name: auth-v1-open
        strip_path: true
        paths:
          - /auth/v1/verify
    plugins:
      - name: cors
  - name: auth-v1-open-callback
    url: http://supabase-auth:9999/callback
    routes:
      - name: auth-v1-open-callback
        strip_path: true
        paths:
          - /auth/v1/callback
    plugins:
      - name: cors
  - name: auth-v1-open-authorize
    url: http://supabase-auth:9999/authorize
    routes:
      - name: auth-v1-open-authorize
        strip_path: true
        paths:
          - /auth/v1/authorize
    plugins:
      - name: cors

  ## Secure Auth routes
  - name: auth-v1
    url: http://supabase-auth:9999/
    routes:
      - name: auth-v1-all
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: false
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon

  ## Secure REST routes
  - name: rest-v1
    url: http://supabase-rest:3000/
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
      - name: acl
        config:
          hide_groups_header: true
          allow:
            - admin
            - anon
KONGEOF

  dots "Writing Kong config"; dots_done
}

# ─── Write DB Init SQL ──────────────────────────────────────────────────────
write_db_init() {
  [ "$DB_MODE" != "docker" ] && return

  mkdir -p "$INSTALL_DIR/volumes/db"

  # Roles init (required for GoTrue + PostgREST)
  cat > "$INSTALL_DIR/volumes/db/roles.sql" << 'ROLESEOF'
-- Supabase roles required by GoTrue and PostgREST
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin LOGIN NOINHERIT CREATEROLE CREATEDB;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    CREATE ROLE supabase_admin LOGIN NOINHERIT CREATEROLE CREATEDB REPLICATION BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

-- Grant roles
GRANT anon TO authenticator;
GRANT authenticated TO authenticator;
GRANT service_role TO authenticator;
GRANT supabase_auth_admin TO authenticator;
GRANT supabase_admin TO postgres;

-- Auth schema
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT USAGE ON SCHEMA auth TO postgres;
ALTER ROLE supabase_auth_admin SET search_path = 'auth';

-- Set passwords (will be replaced by entrypoint)
ALTER ROLE supabase_auth_admin WITH PASSWORD 'POSTGRES_PASSWORD_PLACEHOLDER';
ALTER ROLE authenticator WITH PASSWORD 'POSTGRES_PASSWORD_PLACEHOLDER';
ALTER ROLE supabase_admin WITH PASSWORD 'POSTGRES_PASSWORD_PLACEHOLDER';
ROLESEOF

  # Kortix extensions and schemas
  cat > "$INSTALL_DIR/volumes/db/kortix.sql" << 'KORTIXEOF'
-- Kortix bootstrap: extensions and schemas
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE SCHEMA IF NOT EXISTS kortix;
CREATE SCHEMA IF NOT EXISTS basejump;

-- Scheduler helper (pg_cron → tick endpoint)
CREATE OR REPLACE FUNCTION kortix.configure_scheduler(api_url TEXT, tick_secret TEXT)
RETURNS void AS $$
BEGIN
  PERFORM cron.unschedule('kortix_global_tick')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kortix_global_tick');
  PERFORM cron.schedule(
    'kortix_global_tick',
    '* * * * *',
    format(
      'SELECT net.http_post(url := %L, headers := ''{"Content-Type": "application/json", "x-cron-secret": "%s"}''::jsonb, body := ''{"source": "pg_cron"}''::jsonb, timeout_milliseconds := 30000)',
      api_url || '/v1/cron/tick',
      tick_secret
    )
  );
END;
$$ LANGUAGE plpgsql;

-- PostgREST needs these grants
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO anon, authenticated, service_role;
KORTIXEOF

  dots "Writing DB init scripts"; dots_done
}

# ─── Write docker-compose.yml ───────────────────────────────────────────────
write_compose() {
  dots "Writing docker-compose.yml"

  # Port bindings — local binds to 127.0.0.1, VPS binds to 0.0.0.0
  local bind_addr="127.0.0.1"
  [ "$DEPLOY_MODE" = "vps" ] && bind_addr="0.0.0.0"

  local frontend_ports="    ports:
      - \"${bind_addr}:13737:3000\""
  local api_ports="    ports:
      - \"${bind_addr}:13738:8008\""
  local supabase_ports="    ports:
      - \"${bind_addr}:13740:8000\""
  local db_ports="    ports:
      - \"${bind_addr}:13741:5432\""

  # Supabase services (Docker mode only)
  local supabase_services="" supabase_volumes="" api_depends frontend_supabase_env
  local supabase_url_env supabase_db_env

  if [ "$DB_MODE" = "docker" ]; then
    supabase_services="
  supabase-db:
    image: ${SUPABASE_POSTGRES_IMAGE}
${db_ports}
    volumes:
      - supabase-db-data:/var/lib/postgresql/data
      - ./volumes/db/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:Z
      - ./volumes/db/kortix.sql:/docker-entrypoint-initdb.d/init-scripts/99-kortix.sql:Z
    environment:
      POSTGRES_HOST: /var/run/postgresql
      POSTGRES_PORT: \"5432\"
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
      POSTGRES_DB: postgres
      JWT_SECRET: \${SUPABASE_JWT_SECRET}
      JWT_EXP: \"3600\"
    command:
      - postgres
      - -c
      - config_file=/etc/postgresql/postgresql.conf
      - -c
      - log_min_messages=fatal
    healthcheck:
      test: [\"CMD-SHELL\", \"pg_isready -U postgres -h localhost\"]
      interval: 5s
      timeout: 3s
      retries: 15
      start_period: 10s
    restart: unless-stopped

  supabase-auth:
    image: ${SUPABASE_GOTRUE_IMAGE}
    depends_on:
      supabase-db:
        condition: service_healthy
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: \"9999\"
      API_EXTERNAL_URL: \${SUPABASE_PUBLIC_URL}
      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://supabase_auth_admin:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres
      GOTRUE_SITE_URL: \${PUBLIC_URL}
      GOTRUE_URI_ALLOW_LIST: \"\"
      GOTRUE_DISABLE_SIGNUP: \"false\"
      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: \"3600\"
      GOTRUE_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      GOTRUE_EXTERNAL_EMAIL_ENABLED: \"true\"
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: \"false\"
      GOTRUE_MAILER_AUTOCONFIRM: \"true\"
      GOTRUE_SMTP_ADMIN_EMAIL: admin@localhost
      GOTRUE_SMTP_HOST: localhost
      GOTRUE_SMTP_PORT: \"587\"
      GOTRUE_SMTP_USER: unused
      GOTRUE_SMTP_PASS: unused
      GOTRUE_SMTP_SENDER_NAME: Kortix
      GOTRUE_MAILER_URLPATHS_INVITE: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /auth/v1/verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /auth/v1/verify
    healthcheck:
      test: [\"CMD\", \"wget\", \"--no-verbose\", \"--tries=1\", \"--spider\", \"http://localhost:9999/health\"]
      timeout: 5s
      interval: 5s
      retries: 3
    restart: unless-stopped

  supabase-rest:
    image: ${SUPABASE_REST_IMAGE}
    depends_on:
      supabase-db:
        condition: service_healthy
    environment:
      PGRST_DB_URI: postgres://authenticator:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres
      PGRST_DB_SCHEMAS: public
      PGRST_DB_ANON_ROLE: anon
      PGRST_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      PGRST_DB_USE_LEGACY_GUCS: \"false\"
      PGRST_APP_SETTINGS_JWT_SECRET: \${SUPABASE_JWT_SECRET}
      PGRST_APP_SETTINGS_JWT_EXP: \"3600\"
    command: [\"postgrest\"]
    restart: unless-stopped

  supabase-kong:
    image: ${SUPABASE_KONG_IMAGE}
${supabase_ports}
    volumes:
      - ./volumes/api/kong.yml:/home/kong/temp.yml:ro
    depends_on:
      supabase-auth:
        condition: service_healthy
    environment:
      KONG_DATABASE: \"off\"
      KONG_DECLARATIVE_CONFIG: /home/kong/kong.yml
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_PLUGINS: request-transformer,cors,key-auth,acl,basic-auth
      KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: 160k
      KONG_NGINX_PROXY_PROXY_BUFFERS: 64 160k
      SUPABASE_ANON_KEY: \${SUPABASE_ANON_KEY}
      SUPABASE_SERVICE_KEY: \${SUPABASE_SERVICE_ROLE_KEY}
    entrypoint: bash -c 'eval \"echo \\\"\$\$(cat ~/temp.yml)\\\"\" > ~/kong.yml && /docker-entrypoint.sh kong docker-start'
    restart: unless-stopped
"
    supabase_volumes="  supabase-db-data:"

    api_depends="    depends_on:
      supabase-db:
        condition: service_healthy
      supabase-auth:
        condition: service_healthy"

    # Frontend env vars for Supabase connection.
    #
    # CRITICAL: The server-side SUPABASE_URL MUST match the client-side
    # NEXT_PUBLIC_SUPABASE_URL. The @supabase/ssr library derives cookie
    # names from the URL hostname. If they differ, auth breaks (redirect loop).
    #
    # Both modes use the same HTTP-based pattern: Kong is exposed on host port
    # 13740 via the bind address. The frontend container uses extra_hosts to
    # resolve localhost to the host gateway.
    frontend_supabase_env="      - KORTIX_PUBLIC_SUPABASE_URL=\${SUPABASE_PUBLIC_URL}
      - KORTIX_PUBLIC_SUPABASE_ANON_KEY=\${SUPABASE_ANON_KEY}
      - KORTIX_PUBLIC_BACKEND_URL=\${API_PUBLIC_URL}/v1
      - KORTIX_PUBLIC_BILLING_ENABLED=false
      - KORTIX_PUBLIC_ENV_MODE=local
      - KORTIX_PUBLIC_APP_URL=\${PUBLIC_URL}
      - KORTIX_PUBLIC_SANDBOX_ID=\${SANDBOX_CONTAINER_NAME}
      - SUPABASE_URL=\${SUPABASE_PUBLIC_URL}
      - SUPABASE_SERVER_URL=http://supabase-kong:8000
      - SUPABASE_ANON_KEY=\${SUPABASE_ANON_KEY}
      - BACKEND_URL=\${API_PUBLIC_URL}/v1"

    supabase_url_env="      - SUPABASE_URL=http://supabase-kong:8000"
    supabase_db_env="      - DATABASE_URL=postgresql://postgres:\${POSTGRES_PASSWORD}@supabase-db:5432/postgres"

  else
    # External mode — no Supabase containers
    api_depends="    # External Supabase — no local dependencies"
    frontend_supabase_env="      - KORTIX_PUBLIC_SUPABASE_URL=\${SUPABASE_URL}
      - KORTIX_PUBLIC_SUPABASE_ANON_KEY=\${SUPABASE_ANON_KEY}
      - KORTIX_PUBLIC_BACKEND_URL=\${API_PUBLIC_URL}/v1
      - KORTIX_PUBLIC_BILLING_ENABLED=false
      - KORTIX_PUBLIC_ENV_MODE=local
      - KORTIX_PUBLIC_APP_URL=\${PUBLIC_URL}
      - KORTIX_PUBLIC_SANDBOX_ID=\${SANDBOX_CONTAINER_NAME}
      - SUPABASE_URL=\${SUPABASE_URL}
      - SUPABASE_ANON_KEY=\${SUPABASE_ANON_KEY}
      - BACKEND_URL=\${API_PUBLIC_URL}/v1"
    supabase_url_env="      - SUPABASE_URL=\${SUPABASE_URL}"
    supabase_db_env="      - DATABASE_URL=\${DATABASE_URL}"
  fi

  cat > "$INSTALL_DIR/docker-compose.yml" << COMPOSE
# Kortix — auto-generated by get-kortix.sh
# Mode: ${DEPLOY_MODE} | Database: ${DB_MODE}
services:
${supabase_services}
  frontend:
    image: \${FRONTEND_IMAGE}
${frontend_ports}
    extra_hosts:
      - "localhost:host-gateway"
    environment:
${frontend_supabase_env}
    depends_on:
      kortix-api:
        condition: service_started
    restart: unless-stopped

  kortix-api:
    image: \${API_IMAGE}
    user: "0:0"
${api_ports}
    environment:
      - PORT=8008
${supabase_url_env}
${supabase_db_env}
      - SUPABASE_SERVICE_ROLE_KEY=\${SUPABASE_SERVICE_ROLE_KEY}
      - ALLOWED_SANDBOX_PROVIDERS=local_docker
      - KORTIX_LOCAL_IMAGES=\${KORTIX_LOCAL_IMAGES}
      - DOCKER_HOST=unix:///var/run/docker.sock
      - KORTIX_URL=http://kortix-api:8008/v1/router
      - SANDBOX_NETWORK=${SANDBOX_NETWORK}
      - INTERNAL_SERVICE_KEY=\${INTERNAL_SERVICE_KEY}
      - FRONTEND_URL=\${PUBLIC_URL}
      - API_KEY_SECRET=\${API_KEY_SECRET}
      - CORS_ALLOWED_ORIGINS=\${PUBLIC_URL}
      - SANDBOX_IMAGE=\${SANDBOX_IMAGE}
      - SANDBOX_VERSION=\${KORTIX_VERSION}
      - TUNNEL_SIGNING_SECRET=\${TUNNEL_SIGNING_SECRET}
      - KORTIX_ROUTER_INTERNAL_ENABLED=false
      - KORTIX_BILLING_INTERNAL_ENABLED=false
    env_file:
      - .env
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
${api_depends}
    restart: unless-stopped

volumes:
${supabase_volumes}
COMPOSE

  dots_done
}

# ─── Write .env ──────────────────────────────────────────────────────────────
write_env() {
  cat > "$INSTALL_DIR/.env" << ENVEOF
# ──────────────────────────────────────────────────────────────────────────────
# Kortix — Environment Configuration
# Auto-generated by get-kortix.sh on $(date -u '+%Y-%m-%d %H:%M:%S UTC')
# ──────────────────────────────────────────────────────────────────────────────

# ─── Mode ────────────────────────────────────────────────────────────────────
DEPLOY_MODE=${DEPLOY_MODE}
DB_MODE=${DB_MODE}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME}
KORTIX_LOCAL_IMAGES=${KORTIX_LOCAL_IMAGES}
KORTIX_LOCAL_TAG=${KORTIX_LOCAL_TAG}
KORTIX_LOCAL_REPO_ROOT=${KORTIX_LOCAL_REPO_ROOT}
KORTIX_PULL_PARALLELISM=${KORTIX_PULL_PARALLELISM}

# ─── URLs ────────────────────────────────────────────────────────────────────
PUBLIC_URL=${PUBLIC_URL}
API_PUBLIC_URL=${API_PUBLIC_URL}
SUPABASE_PUBLIC_URL=${SUPABASE_PUBLIC_URL:-http://localhost:13740}

# ─── Supabase ────────────────────────────────────────────────────────────────
SUPABASE_URL=${SUPABASE_URL}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}
DATABASE_URL=${DATABASE_URL}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

# ─── Security ────────────────────────────────────────────────────────────────
INTERNAL_SERVICE_KEY=${INTERNAL_SERVICE_KEY}
API_KEY_SECRET=${API_KEY_SECRET}
TUNNEL_SIGNING_SECRET=${TUNNEL_SIGNING_SECRET}

# ─── Integrations (Pipedream) ────────────────────────────────────────────────
INTEGRATION_AUTH_PROVIDER=${INTEGRATION_AUTH_PROVIDER}
PIPEDREAM_CLIENT_ID=${PIPEDREAM_CLIENT_ID}
PIPEDREAM_CLIENT_SECRET=${PIPEDREAM_CLIENT_SECRET}
PIPEDREAM_PROJECT_ID=${PIPEDREAM_PROJECT_ID}
PIPEDREAM_ENVIRONMENT=${PIPEDREAM_ENVIRONMENT:-production}

# ─── Channels (Slack) ───────────────────────────────────────────────────────
SLACK_CLIENT_ID=${SLACK_CLIENT_ID}
SLACK_CLIENT_SECRET=${SLACK_CLIENT_SECRET}
SLACK_SIGNING_SECRET=${SLACK_SIGNING_SECRET}

# ─── Sandbox ─────────────────────────────────────────────────────────────────
KORTIX_VERSION=${KORTIX_VERSION}
FRONTEND_IMAGE=${FRONTEND_IMAGE}
API_IMAGE=${API_IMAGE}
SANDBOX_IMAGE=${SANDBOX_IMAGE}
SANDBOX_NETWORK=${SANDBOX_NETWORK}
SANDBOX_CONTAINER_NAME=${SANDBOX_CONTAINER_NAME}
SANDBOX_PORT_BASE=${SANDBOX_PORT_BASE}
KORTIX_SANDBOX_VERSION=${KORTIX_VERSION}
ENVEOF

  chmod 600 "$INSTALL_DIR/.env"
  dots "Writing .env"; dots_done
}

write_dev_env_files() {
  local host_addr="localhost"
  [ "$DEPLOY_MODE" = "vps" ] && host_addr="${SERVER_IP}"
  local api_port="13738"
  local host_supabase_url="http://${host_addr}:13740"
  local host_database_url="postgresql://postgres:${POSTGRES_PASSWORD}@${host_addr}:13741/postgres"
  local host_docker_host="$(get_host_docker_socket)"
  local host_sandbox_network="${SANDBOX_NETWORK}"

  cat > "$INSTALL_DIR/.api-dev.env" << ENVEOF
PORT=${api_port}
SUPABASE_URL=${host_supabase_url}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
SUPABASE_JWT_SECRET=${SUPABASE_JWT_SECRET}
DATABASE_URL=${host_database_url}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DOCKER_HOST=${host_docker_host}
ALLOWED_SANDBOX_PROVIDERS=local_docker
KORTIX_LOCAL_IMAGES=${KORTIX_LOCAL_IMAGES}
KORTIX_URL=${API_PUBLIC_URL}/v1/router
SANDBOX_NETWORK=${host_sandbox_network}
INTERNAL_SERVICE_KEY=${INTERNAL_SERVICE_KEY}
ENVEOF

  cat > "$INSTALL_DIR/.frontend-dev.env" << ENVEOF
NEXT_PUBLIC_ENV_MODE=local
NEXT_PUBLIC_BACKEND_URL=${API_PUBLIC_URL}/v1
NEXT_PUBLIC_SUPABASE_URL=${SUPABASE_PUBLIC_URL:-http://localhost:13740}
NEXT_PUBLIC_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}
NEXT_PUBLIC_BILLING_ENABLED=false
ENVEOF

  chmod 600 "$INSTALL_DIR/.api-dev.env" "$INSTALL_DIR/.frontend-dev.env"
  dots "Writing dev env files"; dots_done
}



# ─── Fixup DB init SQL (replace password placeholder) ───────────────────────
fixup_db_init() {
  [ "$DB_MODE" != "docker" ] && return
  # Replace placeholder with actual password in roles.sql
  if [ -f "$INSTALL_DIR/volumes/db/roles.sql" ]; then
    sed -i.bak "s/POSTGRES_PASSWORD_PLACEHOLDER/${POSTGRES_PASSWORD}/g" "$INSTALL_DIR/volumes/db/roles.sql"
    rm -f "$INSTALL_DIR/volumes/db/roles.sql.bak"
  fi
}



# ─── Write CLI ───────────────────────────────────────────────────────────────
write_cli() {
  cat > "$INSTALL_DIR/kortix" << 'CLIPATH'
#!/usr/bin/env bash
set -euo pipefail

# Resolve symlinks so DIR points to the actual install directory
SELF="$0"
[ -L "$SELF" ] && SELF="$(readlink -f "$SELF" 2>/dev/null || readlink "$SELF")"
DIR="$(cd "$(dirname "$SELF")" && pwd)"
cd "$DIR"

# ─── Colors ───────────────────────────────────────────────────────────────
G=$'\033[0;32m'; R=$'\033[0;31m'; C=$'\033[0;36m'; Y=$'\033[1;33m'
W=$'\033[1;37m'; B=$'\033[1m'; D=$'\033[2m'; F=$'\033[2;37m'; N=$'\033[0m'

_info()    { printf "  ${C}▸${N}  %s\n" "$*"; }
_ok()      { printf "  ${G}✓${N}  %s\n" "$*"; }
_warn()    { printf "  ${Y}!${N}  ${Y}%s${N}\n" "$*"; }
_err()     { printf "  ${R}✗${N}  ${R}%s${N}\n" "$*" >&2; }

prompt_read() {
  local __var_name="$1"
  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    IFS= read -r "$__var_name" </dev/tty
  else
    IFS= read -r "$__var_name"
  fi
}

# Installed release metadata is persisted in .env so updates stay pinned.
VERSION=$(grep -m1 '^KORTIX_VERSION=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "unknown")
FRONTEND_IMAGE=$(grep -m1 '^FRONTEND_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/kortix-frontend:${VERSION}")
API_IMAGE=$(grep -m1 '^API_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/kortix-api:${VERSION}")
SANDBOX_IMAGE=$(grep -m1 '^SANDBOX_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/computer:${VERSION}")
SANDBOX_NAME=$(grep -m1 '^SANDBOX_CONTAINER_NAME=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix-hosted-sandbox")
LOCAL_IMAGES=$(grep -m1 '^KORTIX_LOCAL_IMAGES=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "0")
LOCAL_TAG=$(grep -m1 '^KORTIX_LOCAL_TAG=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "latest")
LOCAL_REPO_ROOT=$(grep -m1 '^KORTIX_LOCAL_REPO_ROOT=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
DEFAULT_PULL_PARALLELISM=$(grep -m1 '^KORTIX_PULL_PARALLELISM=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || true)
DEFAULT_PULL_PARALLELISM="${DEFAULT_PULL_PARALLELISM:-4}"
KORTIX_PULL_PARALLELISM="${KORTIX_PULL_PARALLELISM:-$DEFAULT_PULL_PARALLELISM}"
KORTIX_NETWORK_RETRIES="${KORTIX_NETWORK_RETRIES:-3}"
KORTIX_NETWORK_RETRY_DELAY="${KORTIX_NETWORK_RETRY_DELAY:-2}"

_run_with_retry() {
  local attempts="$1" delay="$2"
  shift 2

  local attempt=1
  local status=0
  while true; do
    if "$@"; then
      return 0
    fi
    status=$?
    if [ "$attempt" -ge "$attempts" ]; then
      return "$status"
    fi
    attempt=$((attempt + 1))
    sleep "$delay"
  done
}

_curl_with_retry() {
  _run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" curl "$@"
}

_docker_pull_with_retry() {
  local image="$1"
  _run_with_retry "$KORTIX_NETWORK_RETRIES" "$KORTIX_NETWORK_RETRY_DELAY" docker pull "$image"
}

_pull_images_parallel() {
  local -a images=("$@")
  [ ${#images[@]} -gt 0 ] || return 0

  export -f _run_with_retry _docker_pull_with_retry
  export KORTIX_NETWORK_RETRIES KORTIX_NETWORK_RETRY_DELAY
  printf '%s\n' "${images[@]}" \
    | python3 -c 'import sys; print("\n".join(sorted(set(line.strip() for line in sys.stdin if line.strip()))))' \
    | xargs -r -I{} -P "$KORTIX_PULL_PARALLELISM" bash -c '_docker_pull_with_retry "$1"' _ "{}"
}

_compose_up_or_exit() {
  if docker compose up -d; then
    return 0
  fi
  _err "Failed to start services."
  printf "  ${F}Inspect with: cd %s && docker compose ps && docker compose logs --tail=200${N}\n" "$DIR"
  exit 1
}

_compose_down_best_effort() {
  local context="$1"
  shift

  if docker compose down "$@" 2>/dev/null; then
    return 0
  fi
  _warn "Could not stop ${context} cleanly; continuing."
}

_resolve_latest_version() {
  local gh_version
  gh_version=$(_curl_with_retry -sf --connect-timeout 5 \
    "https://api.github.com/repos/kortix-ai/suna/releases/latest" 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))' 2>/dev/null) || true
  if [ -n "$gh_version" ]; then
    printf '%s' "$gh_version"
    return
  fi
  printf 'latest'
}

_env_set() {
  local key="$1" value="$2"
  python3 - "$DIR/.env" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines() if path.exists() else []
prefix = key + '='
for i, line in enumerate(lines):
    if line.startswith(prefix):
        lines[i] = prefix + value
        break
else:
    lines.append(prefix + value)
path.write_text('\n'.join(lines) + '\n')
PY
}

_refresh_state_from_env() {
  VERSION=$(grep -m1 '^KORTIX_VERSION=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "unknown")
  FRONTEND_IMAGE=$(grep -m1 '^FRONTEND_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/kortix-frontend:${VERSION}")
  API_IMAGE=$(grep -m1 '^API_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/kortix-api:${VERSION}")
  SANDBOX_IMAGE=$(grep -m1 '^SANDBOX_IMAGE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix/computer:${VERSION}")
}

_patch_compose_images() {
  python3 - "$DIR/docker-compose.yml" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
if not path.exists():
    raise SystemExit(0)
lines = path.read_text().splitlines()
service = None
out = []
for line in lines:
    stripped = line.strip()
    if stripped == 'frontend:':
        service = 'frontend'
        out.append(line)
        continue
    if stripped == 'kortix-api:':
        service = 'kortix-api'
        out.append(line)
        continue
    if service and stripped.startswith('image:'):
        indent = line[:len(line) - len(line.lstrip())]
        if service == 'frontend':
            out.append(f"{indent}image: ${{FRONTEND_IMAGE}}")
        else:
            out.append(f"{indent}image: ${{API_IMAGE}}")
        service = None
        continue
    out.append(line)
path.write_text('\n'.join(out) + '\n')
PY
}

_refresh_installer_and_cli() {
  local tmp_script="$DIR/get-kortix.sh.tmp"
  _curl_with_retry -fsSL "https://raw.githubusercontent.com/kortix-ai/suna/main/scripts/get-kortix.sh" -o "$tmp_script" || return 0
  chmod +x "$tmp_script"
  mv "$tmp_script" "$DIR/get-kortix.sh"
  awk '
    capture && $0 == "CLIPATH" { exit }
    capture { print; next }
    /<< '\''CLIPATH'\''$/ { capture = 1 }
  ' "$DIR/get-kortix.sh" > "$DIR/kortix.new" && chmod +x "$DIR/kortix.new" && mv "$DIR/kortix.new" "$DIR/kortix" || true
}

_show_update_notice() {
  [ "$LOCAL_IMAGES" = "1" ] && return 0
  local latest
  latest=$(_resolve_latest_version)
  [ -n "$latest" ] || return 0
  [ "$latest" = "$VERSION" ] && return 0
  printf "  ${Y}!${N}  ${Y}Update available:${N} v%s ${F}(run: kortix update)${N}\n" "$latest"
}

_open() {
  if command -v open &>/dev/null; then open "$1" 2>/dev/null
  elif command -v xdg-open &>/dev/null; then xdg-open "$1" 2>/dev/null
  elif command -v wslview &>/dev/null; then wslview "$1" 2>/dev/null
  fi
}

_url() {
  if [ -f "$DIR/.env" ]; then
    grep -m1 '^PUBLIC_URL=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "http://localhost:13737"
  else
    echo "http://localhost:13737"
  fi
}

_api_url() {
  if [ -f "$DIR/.env" ]; then
    grep -m1 '^API_PUBLIC_URL=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "http://localhost:13738"
  else
    echo "http://localhost:13738"
  fi
}

_mode() {
  if [ -f "$DIR/.env" ]; then
    grep -m1 '^DEPLOY_MODE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "local"
  else
    echo "local"
  fi
}

_project_name() {
  if [ -f "$DIR/.env" ]; then
    grep -m1 '^COMPOSE_PROJECT_NAME=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "kortix"
  else
    echo "kortix"
  fi
}

# Free ports used by Kortix (local mode)
_free_kortix_ports() {
  local project_name
  project_name=$(_project_name)
  local ports=(13737 13738 13740 13741)
  local freed=0

  # Clean up lingering compose containers from this project.
  # EXCLUDES standalone sandbox containers (managed by the API, not compose).
  docker ps -a --format '{{.Names}}' 2>/dev/null \
    | grep -E "^${project_name}-" \
    | grep -v -E "^(kortix-sandbox|${SANDBOX_NAME})$" \
    | xargs -r docker rm -f 2>/dev/null || true

  # Kill any processes using the ports
  for port in "${ports[@]}"; do
    local pid
    pid=$(lsof -t -i:$port 2>/dev/null || true)
    if [ -n "$pid" ]; then
      kill -9 $pid 2>/dev/null || true
      freed=1
    fi
  done

  [ $freed -eq 1 ] && _info "Freed Kortix ports" || true
}

_sync_supabase_passwords() {
  [ -f "$DIR/.env" ] || return 0

  local db_mode db_password escaped_password attempts
  db_mode=$(grep -m1 '^DB_MODE=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
  [ "$db_mode" = "docker" ] || return 0

  db_password=$(grep -m1 '^POSTGRES_PASSWORD=' "$DIR/.env" 2>/dev/null | cut -d= -f2- || echo "")
  [ -n "$db_password" ] || return 0

  escaped_password=${db_password//\'/\'\'}

  docker compose up -d supabase-db >/dev/null 2>&1 || return 0

  attempts=0
  until docker compose exec -T supabase-db sh -lc 'pg_isready -U postgres -h localhost >/dev/null 2>&1'; do
    attempts=$((attempts + 1))
    [ $attempts -ge 30 ] && return 0
    sleep 1
  done

  printf "SET ROLE supabase_admin;\nALTER ROLE supabase_auth_admin WITH PASSWORD '%s';\nALTER ROLE authenticator WITH PASSWORD '%s';\nALTER ROLE supabase_admin WITH PASSWORD '%s';\n" \
    "$escaped_password" "$escaped_password" "$escaped_password" \
    | docker compose exec -T supabase-db sh -lc 'psql -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null' >/dev/null 2>&1 || true
}

_using_local_images() {
  [ "$LOCAL_IMAGES" = "1" ]
}

_rebuild_local_images() {
  [ -n "$LOCAL_REPO_ROOT" ] || { _err "KORTIX_LOCAL_REPO_ROOT is not set"; exit 1; }
  local build_script="$LOCAL_REPO_ROOT/scripts/build-local-images.sh"
  [ -f "$build_script" ] || { _err "Build script not found: ${build_script}"; exit 1; }
  bash "$build_script" --tag "$LOCAL_TAG"
}

_reset_stack() {
  local yes_flag="${1:-}"
  if [ "$yes_flag" != "--yes" ]; then
    printf "  ${Y}!${N}  Reset local data and recreate the stack? [y/N]: "
    prompt_read reset_confirm
    echo "$reset_confirm" | grep -qi '^y' || {
      _warn "Reset cancelled."
      exit 0
    }
  fi

  _info "Stopping and removing stack..."
  _compose_down_best_effort "existing services" -v --remove-orphans
  docker rm -f "$SANDBOX_NAME" 2>/dev/null || true
  docker volume rm "${SANDBOX_NAME}-data" 2>/dev/null || true
  [ "$(_mode)" = "local" ] && _free_kortix_ports

  _info "Starting fresh stack..."
  _compose_up_or_exit
  if ! _wait_for_api_health; then
    _fail_stack_not_ready
  fi
  _ok "Reset complete."
}

_wait_for_api_health() {
  local api_url
  api_url="$(_api_url)"
  local attempts=0
  while [ $attempts -lt 60 ]; do
    if curl -fsS "${api_url}/v1/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    attempts=$((attempts + 1))
  done
  return 1
}

_fail_stack_not_ready() {
  _err "Services did not become healthy in time."
  printf "  ${F}Inspect with: cd %s && docker compose ps && docker compose logs --tail=200${N}\n" "$DIR"
  exit 1
}

_refresh_sandbox_container() {
  [ "$(_mode)" = "local" ] || return 0
  local api_url warm_url status_url payload status progress message attempts
  api_url="$(_api_url)"
  warm_url="${api_url}/v1/setup/local-sandbox/warm"
  status_url="${api_url}/v1/setup/local-sandbox/warm/status"

  _info "Refreshing sandbox container..."
  docker rm -f "$SANDBOX_NAME" >/dev/null 2>&1 || true

  curl -sf -X POST "$warm_url" >/dev/null || {
    _warn "Could not trigger sandbox warmup; it will recreate lazily on first use."
    return 0
  }

  attempts=0
  while [ $attempts -lt 180 ]; do
    payload=$(curl -sf "$status_url" 2>/dev/null || true)
    status=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("status", ""))')
    progress=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("progress", ""))')
    message=$(JSON_PAYLOAD="$payload" python3 -c 'import json, os; data=json.loads(os.environ.get("JSON_PAYLOAD") or "{}"); print(data.get("message", ""))')

    case "$status" in
      ready)
        _ok "Sandbox refreshed"
        return 0
        ;;
      error)
        _warn "Sandbox refresh failed: ${message:-unknown}"
        return 0
        ;;
      pulling|creating)
        printf "\r  ${C}▸${N}  Sandbox: ${message:-starting}${progress:+ (${progress}%%)}          "
        ;;
      *)
        printf "\r  ${C}▸${N}  Sandbox: bootstrapping...          "
        ;;
    esac

    sleep 2
    attempts=$((attempts + 1))
  done

  printf "\n"
  _warn "Sandbox refresh timed out — it may still complete in the background."
}

_banner() {
  printf "\n"
  printf "  ${C}${B}Kortix CLI${N}  ${F}v${VERSION}${N}\n"
  printf "  ${F}────────────────────────────────────────${N}\n"
  _show_update_notice
}

case "${1:-help}" in
  start)
    _banner
    [ "$(_mode)" = "local" ] && _free_kortix_ports
    _sync_supabase_passwords
    _compose_up_or_exit
    # Also restart the sandbox container if it exists but is stopped
    if docker ps -a --format '{{.Names}}' | grep -q "^${SANDBOX_NAME}$"; then
      if ! docker ps --format '{{.Names}}' | grep -q "^${SANDBOX_NAME}$"; then
        _info "Restarting sandbox container..."
        docker start "$SANDBOX_NAME" 2>/dev/null || true
      fi
    fi
    if ! _wait_for_api_health; then
      _fail_stack_not_ready
    fi
    echo ""
    _ok "Kortix is running!"
    printf "  ${W}Dashboard${N}:  ${C}$(_url)${N}\n\n"
    ;;
  stop)
    _banner
    _compose_down_best_effort "services"
    docker stop "$SANDBOX_NAME" 2>/dev/null || true
    _ok "All services stopped."
    echo ""
    ;;
  restart)
    _banner
    _compose_down_best_effort "existing services"
    [ "$(_mode)" = "local" ] && _free_kortix_ports
    _sync_supabase_passwords
    _compose_up_or_exit
    if ! _wait_for_api_health; then
      _fail_stack_not_ready
    fi
    _ok "Restarted."
    printf "  ${W}Dashboard${N}:  ${C}$(_url)${N}\n\n"
    ;;
  logs)
    shift
    docker compose logs -f "$@"
    ;;
  status)
    _banner
    docker compose ps
    echo ""
    ;;
  setup)
    _info "Opening sign-in in browser..."
    _open "$(_url)/auth"
    printf "  ${F}If it didn't open: ${W}$(_url)/auth${N}\n\n"
    ;;
  update)
    _banner
    shift
    if [ "${1:-}" = "--build-local" ]; then
      _rebuild_local_images
    fi
    if _using_local_images; then
      _info "Using local Docker images..."
    else
      local_latest=$(_resolve_latest_version)
      if [ -n "$local_latest" ] && [ "$local_latest" != "$VERSION" ]; then
        _info "Updating from v${VERSION} to v${local_latest}..."
        VERSION="$local_latest"
        FRONTEND_IMAGE="kortix/kortix-frontend:${VERSION}"
        API_IMAGE="kortix/kortix-api:${VERSION}"
        SANDBOX_IMAGE="kortix/computer:${VERSION}"
        _env_set KORTIX_VERSION "$VERSION"
        _env_set KORTIX_SANDBOX_VERSION "$VERSION"
        _env_set FRONTEND_IMAGE "$FRONTEND_IMAGE"
        _env_set API_IMAGE "$API_IMAGE"
        _env_set SANDBOX_IMAGE "$SANDBOX_IMAGE"
        _patch_compose_images
        _refresh_state_from_env
      else
        _info "Already on latest stable release (v${VERSION}) — refreshing images..."
      fi
      _info "Pulling latest release images..."
      release_images_output=$({
        docker compose config --images
        printf '%s\n' "$SANDBOX_IMAGE"
      } | python3 -c 'import sys; print("\n".join(sorted(set(line.strip() for line in sys.stdin if line.strip()))))')
      mapfile -t release_images < <(printf '%s\n' "$release_images_output")
      _pull_images_parallel "${release_images[@]}"
    fi
    _info "Restarting services..."
    [ "$(_mode)" = "local" ] && _free_kortix_ports
    _sync_supabase_passwords
    _compose_down_best_effort "existing services"
    _compose_up_or_exit
    if ! _wait_for_api_health; then
      _fail_stack_not_ready
    fi
    _refresh_sandbox_container
    _refresh_installer_and_cli
    _ok "Updated and running."
    printf "  ${W}Dashboard${N}:  ${C}$(_url)${N}\n\n"
    ;;
  reset)
    _banner
    shift
    _reset_stack "${1:-}"
    ;;
  uninstall)
    _banner
    _info "Stopping services..."
    docker stop "$SANDBOX_NAME" 2>/dev/null || true
    docker rm -f "$SANDBOX_NAME" 2>/dev/null || true
    printf "\n  ${Y}!${N}  Delete all data (Docker volumes)? [y/N]: "
    prompt_read del_volumes
    if echo "$del_volumes" | grep -qi '^y'; then
      _compose_down_best_effort "existing services" -v --remove-orphans
      docker volume rm "${SANDBOX_NAME}-data" 2>/dev/null || true
      docker volume rm kortix_supabase-db-data 2>/dev/null || true
      docker volume rm supabase_db_kortix-local 2>/dev/null || true
      _ok "Volumes removed."
    else
      _compose_down_best_effort "existing services"
    fi
    [ -L "/usr/local/bin/kortix" ] && rm -f /usr/local/bin/kortix 2>/dev/null || true
    rm -rf "$DIR"
    _ok "Kortix uninstalled."
    echo ""
    ;;
  open)
    _open "$(_url)"
    ;;
  version)
    echo "  kortix v${VERSION}"
    ;;
  *)
    _banner
    echo ""
    printf "  ${C}start${N}       Start all services\n"
    printf "  ${C}stop${N}        Stop all services\n"
    printf "  ${C}restart${N}     Restart all services\n"
    printf "  ${C}logs${N}        Tail logs ${F}(kortix logs kortix-api)${N}\n"
    printf "  ${C}status${N}      Show running containers\n"
    printf "  ${C}setup${N}       Open sign-in page\n"
    printf "  ${C}update${N}      Pull latest images & restart\n"
    printf "  ${C}reset${N}       Wipe data and recreate stack\n"
    printf "  ${C}uninstall${N}   Remove Kortix completely\n"
    printf "  ${C}open${N}        Open dashboard in browser\n"
    printf "  ${C}version${N}     Show installed version\n"
    echo ""
    ;;
 esac
CLIPATH

  chmod +x "$INSTALL_DIR/kortix"
}

# ─── Add to PATH ─────────────────────────────────────────────────────────────
setup_path() {
  if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
    ln -sf "$INSTALL_DIR/kortix" /usr/local/bin/kortix 2>/dev/null && {
      success "Linked 'kortix' -> /usr/local/bin/kortix"
      return
    }
  fi

  local shell_rc=""
  case "${SHELL:-}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  if [ -f "$shell_rc" ] && grep -q "$INSTALL_DIR" "$shell_rc" 2>/dev/null; then
    return
  fi

  echo "" >> "$shell_rc"
  echo "# Kortix CLI" >> "$shell_rc"
  echo "export PATH=\"$INSTALL_DIR:\$PATH\"" >> "$shell_rc"
  success "Added 'kortix' to PATH (restart terminal or: source $shell_rc)"
}

# ─── Pull & Start ───────────────────────────────────────────────────────────
pull_and_start() {
  cd "$INSTALL_DIR"

  section "Docker Images"

  if [ "$KORTIX_LOCAL_IMAGES" = "1" ]; then
    if [ "$KORTIX_BUILD_LOCAL_IMAGES" = "1" ]; then
      rebuild_local_images
    fi
    info "Using local images (skipping registry)"
    verify_local_image "$FRONTEND_IMAGE"
    verify_local_image "$API_IMAGE"
    verify_local_image "$SANDBOX_IMAGE"
    success "All local images verified"
  else
    info "Pulling images in parallel..."
    echo ""
    local -a images_to_pull=("$FRONTEND_IMAGE" "$API_IMAGE" "$SANDBOX_IMAGE")
    if [ "$DB_MODE" = "docker" ]; then
      images_to_pull+=("$SUPABASE_POSTGRES_IMAGE" "$SUPABASE_GOTRUE_IMAGE" "$SUPABASE_REST_IMAGE" "$SUPABASE_KONG_IMAGE")
    fi
    pull_images_parallel "${images_to_pull[@]}"
    echo ""
    success "All images pulled"
  fi

  section "Starting Services"

  # Free ports in local mode to avoid conflicts
  free_kortix_ports

  if ! docker compose up -d; then
    fatal "Docker Compose failed to start the stack. Inspect with: cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=200"
  fi

  if ! wait_for_http_ready "${PUBLIC_URL}" "services"; then
    fatal "Kortix services did not become ready in time. Inspect with: cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=200"
  fi

  if [ "$DEPLOY_MODE" = "local" ]; then
    warm_local_sandbox
  fi

  # ─── Final success output ────────────────────────────────────────────
  printf "\n"
  printf "  ${GREEN}${BOLD}╔══════════════════════════════════════════════════╗${NC}\n"
  printf "  ${GREEN}${BOLD}║             Kortix is running!                  ║${NC}\n"
  printf "  ${GREEN}${BOLD}╚══════════════════════════════════════════════════╝${NC}\n"
  printf "\n"
  printf "    ${WHITE}Dashboard${NC}   ${CYAN}${BOLD}${PUBLIC_URL}${NC}\n"
  printf "    ${WHITE}API${NC}         ${CYAN}${BOLD}${API_PUBLIC_URL}${NC}\n"
  printf "\n"

  if [ "$DEPLOY_MODE" = "local" ]; then
    info "Opening sign-in page..."
    open_browser "${PUBLIC_URL}/auth"
  fi

  if [ "$DEPLOY_MODE" = "vps" ]; then
    subsection "Reverse Proxy Ports"
    printf "    Frontend  ${WHITE}:13737${NC}    API  ${WHITE}:13738${NC}    Supabase  ${WHITE}:13740${NC}\n"
    printf "    ${FADED}Point Caddy / nginx / Cloudflare at these for HTTPS${NC}\n"
  fi

  if [ "$DEPLOY_MODE" = "local" ]; then
    subsection "Want 24/7 uptime?"
    printf "    ${WHITE}Kortix Cloud${NC}   ${CYAN}https://kortix.com${NC}     ${FADED}managed, zero setup${NC}\n"
    printf "    ${WHITE}Self-host${NC}      ${CYAN}hetzner.com${NC} / ${CYAN}justavps.com${NC}\n"
  fi

  subsection "Next Steps"
  printf "    Open the dashboard and create your owner account.\n"

  subsection "CLI Reference"
  printf "    ${CYAN}kortix start${NC}    Start services\n"
  printf "    ${CYAN}kortix stop${NC}     Stop services\n"
  printf "    ${CYAN}kortix setup${NC}    Open sign-in page\n"
  printf "    ${CYAN}kortix update${NC}   Pull latest & restart\n"
  printf "    ${CYAN}kortix logs${NC}     Tail service logs\n"
  printf "    ${CYAN}kortix status${NC}   Show running containers\n"
  printf "\n"
}

# ─── Main ────────────────────────────────────────────────────────────────────
main() {
  banner
  preflight

  # Clean up any stale Docker volumes from a previous install that was
  # manually removed (rm -rf ~/.kortix) without running `docker compose down -v`.
  # Without this, fresh installs reuse old Postgres data with old passwords,
  # causing supabase-auth to fail with SASL auth errors.
  if [ ! -f "$INSTALL_DIR/docker-compose.yml" ]; then
    docker volume rm kortix_supabase-db-data 2>/dev/null || true
    docker rm -f "${SANDBOX_CONTAINER_NAME}" 2>/dev/null || true
    docker volume rm "${SANDBOX_CONTAINER_NAME}-data" 2>/dev/null || true
  fi

  # Existing install?
  if [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    section "Existing Installation"
    warn "Found existing install at ${WHITE}$INSTALL_DIR${NC}"
    printf "    ${FADED}Reinstalling will stop services and regenerate secrets.${NC}\n"
    printf "\n    Reinstall? [${YELLOW}y${NC}/${FADED}N${NC}]: "
    prompt_read answer
    if [ -z "$answer" ] || ! echo "$answer" | grep -qi '^y'; then
      info "Starting existing installation..."
      cd "$INSTALL_DIR"
      if ! docker compose up -d; then
        fatal "Docker Compose failed to start the existing installation. Inspect with: cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=200"
      fi
      local existing_url
      existing_url=$(grep -m1 '^PUBLIC_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2- || echo "http://localhost:13737")
      if ! wait_for_http_ready "$existing_url" "existing installation"; then
        fatal "Existing installation did not become ready in time. Inspect with: cd $INSTALL_DIR && docker compose ps && docker compose logs --tail=200"
      fi
      echo ""
      success "Kortix is running!"
      printf "    ${WHITE}Dashboard${NC}:  ${CYAN}${existing_url}${NC}\n\n"
      exit 0
    fi
    info "Stopping old services..."
    cd "$INSTALL_DIR"
    # Down with -v to remove volumes (especially supabase-db-data).
    # Without this, old Postgres data retains old passwords while the
    # installer generates new ones, causing supabase-auth to fail with
    # "password authentication failed for user supabase_auth_admin".
    if ! docker compose down -v 2>/dev/null; then
      warn "Could not stop existing compose services cleanly; continuing with reinstall."
    fi
    docker rm -f "${SANDBOX_CONTAINER_NAME}" 2>/dev/null || true
    # Also remove any leftover named volumes from previous installs
    docker volume rm kortix_supabase-db-data 2>/dev/null || true
    docker volume rm supabase_db_kortix-local 2>/dev/null || true
    docker volume rm "${SANDBOX_CONTAINER_NAME}-data" 2>/dev/null || true
    echo ""
  fi

  # ─── Interactive setup ──────────────────────────────────────────────────
  prompt_mode
  prompt_database

  compute_urls

  # Set SUPABASE_PUBLIC_URL for Docker mode
  if [ "$DB_MODE" = "docker" ]; then
    if [ "$DEPLOY_MODE" = "local" ]; then
      SUPABASE_PUBLIC_URL="http://localhost:13740"
    else
      SUPABASE_PUBLIC_URL="http://${SERVER_IP}:13740"
    fi
  fi

  section "Architecture"

  printf "\n"
  if [ "$DB_MODE" = "docker" ]; then
    printf "    ${CYAN}┌──────────┐${NC}    ${CYAN}┌──────────┐${NC}    ${CYAN}┌──────────┐${NC}\n"
    printf "    ${CYAN}│${NC} Frontend ${CYAN}│${NC} →  ${CYAN}│${NC}   API    ${CYAN}│${NC} →  ${CYAN}│${NC} Sandbox  ${CYAN}│${NC}\n"
    printf "    ${CYAN}└──────────┘${NC}    ${CYAN}└────┬─────┘${NC}    ${CYAN}└──────────┘${NC}\n"
    printf "                         ${CYAN}│${NC}\n"
    printf "                  ${CYAN}┌──────┴──────┐${NC}\n"
    printf "                  ${CYAN}│${NC}  Supabase   ${CYAN}│${NC}\n"
    printf "                  ${CYAN}│${NC} ${FADED}DB+Auth+REST${NC} ${CYAN}│${NC}\n"
    printf "                  ${CYAN}└─────────────┘${NC}\n"
  else
    printf "    ${CYAN}┌──────────┐${NC}    ${CYAN}┌──────────┐${NC}    ${CYAN}┌──────────┐${NC}\n"
    printf "    ${CYAN}│${NC} Frontend ${CYAN}│${NC} →  ${CYAN}│${NC}   API    ${CYAN}│${NC} →  ${CYAN}│${NC} Sandbox  ${CYAN}│${NC}\n"
    printf "    ${CYAN}└──────────┘${NC}    ${CYAN}└────┬─────┘${NC}    ${CYAN}└──────────┘${NC}\n"
    printf "                         ${CYAN}│${NC}\n"
    printf "                  ${CYAN}┌──────┴──────┐${NC}\n"
    printf "                  ${CYAN}│${NC} External DB ${CYAN}│${NC}\n"
    printf "                  ${CYAN}│${NC}${FADED}your Supabase${NC} ${CYAN}│${NC}\n"
    printf "                  ${CYAN}└─────────────┘${NC}\n"
  fi
  printf "\n"

  prompt_integrations

  section "Configuring"

  generate_secrets
  resolve_release_images

  mkdir -p "$INSTALL_DIR"

  write_kong_config
  write_db_init
  fixup_db_init
  write_compose
  write_env
  write_dev_env_files
  write_cli
  setup_path

  pull_and_start
}

main "$@"
