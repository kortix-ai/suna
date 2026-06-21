#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/env.sh"

log "Starting throwaway Postgres (${PG_IMAGE}) on port ${TEST_DB_PORT}"
compose up -d "${COMPOSE_SERVICE}"

log "Waiting for healthcheck"
for _ in $(seq 1 60); do
  status="$(compose ps --format '{{.Health}}' "${COMPOSE_SERVICE}" 2>/dev/null || true)"
  if [ "${status}" = "healthy" ]; then
    log "Postgres healthy"
    exit 0
  fi
  sleep 2
done

err "Postgres did not become healthy in time"
compose logs "${COMPOSE_SERVICE}" || true
exit 1
