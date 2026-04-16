#!/bin/bash
# Core supervisor wrapper for OpenCode API server (port 4096)
# Called by kortix-master core supervisor — NOT by s6 directly.

export HOME=/workspace
export KORTIX_PERSISTENT_ROOT="${KORTIX_PERSISTENT_ROOT:-/persistent}"
export OPENCODE_STORAGE_BASE="${OPENCODE_STORAGE_BASE:-${KORTIX_PERSISTENT_ROOT}/opencode}"
export OPENCODE_SHADOW_STORAGE_BASE="${OPENCODE_SHADOW_STORAGE_BASE:-${KORTIX_PERSISTENT_ROOT}/opencode-shadow}"
export KORTIX_OPENCODE_ARCHIVE_DIR="${KORTIX_OPENCODE_ARCHIVE_DIR:-${KORTIX_PERSISTENT_ROOT}/opencode-archive}"
export AUTH_JSON_PATH="${AUTH_JSON_PATH:-${OPENCODE_STORAGE_BASE}/auth.json}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-${KORTIX_PERSISTENT_ROOT}}"
export OPENCODE_CONFIG_DIR=/ephemeral/kortix-master/opencode
export OPENCODE_FILE_ROOT=/
export PATH="/opt/bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [ -x "/usr/local/bin/opencode-kortix" ]; then
  export OPENCODE_BIN_PATH="/usr/local/bin/opencode-kortix"
fi
OPENCODE_BIN="$(command -v opencode || true)"

if [ -z "$OPENCODE_BIN" ]; then
  echo "[opencode-serve] ERROR: opencode binary not found on PATH"
  exit 1
fi

# Drop empty *_BASE_URL vars — empty string causes @ai-sdk to fetch("") → ERR_INVALID_URL
[ -z "$ANTHROPIC_BASE_URL" ] && unset ANTHROPIC_BASE_URL
[ -z "$OPENAI_BASE_URL" ] && unset OPENAI_BASE_URL

# Pick up vars written by kortix-api after container start.
# In cloud mode, tokens are either already in S6 env dir (Docker env from
# Daytona/JustAVPS/pool) or injected within seconds via the /env API.
# Wait up to 10s — combined with DB lock wait (~10s), total must stay under
# ServiceManager's START_WAIT_MS (30s) so OpenCode can bind port 4096.
TOKEN_FILE="/run/s6/container_environment/KORTIX_TOKEN"
API_URL_FILE="/run/s6/container_environment/KORTIX_API_URL"

if [ ! -s "$TOKEN_FILE" ] || [ ! -s "$API_URL_FILE" ]; then
  echo "[opencode-serve] Waiting for KORTIX_TOKEN and KORTIX_API_URL to be provisioned..."
  for i in $(seq 1 5); do
    [ -s "$TOKEN_FILE" ] && [ -s "$API_URL_FILE" ] && break
    sleep 2
  done
fi

[ -s "$TOKEN_FILE" ] && \
  export KORTIX_TOKEN="$(cat "$TOKEN_FILE")"
[ -s "$API_URL_FILE" ] && \
  export KORTIX_API_URL="$(cat "$API_URL_FILE")"

# Safety check: if KORTIX_API_URL is still unset or points to localhost, warn loudly.
# This catches pool sandboxes where env injection failed or was delayed.
if [ -z "$KORTIX_API_URL" ] || echo "$KORTIX_API_URL" | grep -q "localhost"; then
  echo "[opencode-serve] WARNING: KORTIX_API_URL is '${KORTIX_API_URL:-unset}' — LLM calls will fail in cloud mode!"
fi

cd /workspace

# Wait for any previous opencode instance to fully release the SQLite database.
# Rapid restarts leave the DB locked ("unable to open database file") until the
# old process exits and the kernel releases its file descriptors.
if command -v kortix-opencode-state >/dev/null 2>&1; then
  kortix-opencode-state guard >/dev/null 2>&1 || echo "[opencode-serve] WARNING: state guard failed"
fi

DB_PATH="${OPENCODE_STORAGE_BASE}/opencode.db"
for i in $(seq 1 10); do
  # Only check WAL/SHM — these only exist (and stay locked) during or after a crash.
  # The main .db file is held by the running instance which is fine to ignore here.
  if ! fuser "${DB_PATH}-wal" "${DB_PATH}-shm" >/dev/null 2>&1; then
    break
  fi
  echo "[opencode-serve] DB still locked by previous process, waiting (${i}/10)..."
  sleep 1
done

exec "$OPENCODE_BIN" serve --port 4096 --hostname 0.0.0.0
