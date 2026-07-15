#!/bin/sh
# Kortix self-host auto-updater. Runs inside the `kortix-updater` Compose
# service (image: docker:cli, docker socket mounted). On an interval it pulls
# published image tags for this stack and, if anything actually changed, runs
# the migrate one-shot and rolls the stack forward. Single-flight via flock so
# an overlapping cycle never races a previous one.
set -eu

STATE_DIR="/state"
LOCK_FILE="$STATE_DIR/updater.lock"
BREADCRUMB="$STATE_DIR/deployed-version.json"
PROJECT_NAME="${KORTIX_COMPOSE_PROJECT:-kortix}"
INTERVAL="${KORTIX_UPDATE_INTERVAL:-86400}"
COMPOSE="docker compose --project-name $PROJECT_NAME --env-file /workspace/.env -f /workspace/docker-compose.yml"

mkdir -p "$STATE_DIR"

log() {
  echo "[kortix-updater] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# Fingerprint of the image IDs currently backing this stack's services, so we
# only touch anything when a pull actually changed something.
image_fingerprint() {
  $COMPOSE config --images 2>/dev/null | sort -u | while read -r image; do
    docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
  done
}

run_once() {
  if [ "${KORTIX_AUTO_UPDATE:-true}" != "true" ]; then
    log "KORTIX_AUTO_UPDATE is not true; skipping this cycle"
    return 0
  fi

  before=$(image_fingerprint)
  log "pulling images"
  $COMPOSE pull --quiet

  after=$(image_fingerprint)
  if [ "$before" = "$after" ]; then
    log "no image changes; nothing to do"
    return 0
  fi

  log "image digests changed; applying migrations"
  $COMPOSE run --rm --no-deps kortix-migrate

  log "rolling the stack to the new images"
  $COMPOSE up -d --wait

  version=$(grep '^KORTIX_VERSION=' /workspace/.env | tail -n1 | cut -d= -f2-)
  printf '{"deployed_at":"%s","version":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${version:-unknown}" >"$BREADCRUMB"
  log "update complete (version=${version:-unknown})"
}

log "starting (interval=${INTERVAL}s, auto_update=${KORTIX_AUTO_UPDATE:-true})"
while true; do
  (
    flock -n 9 || { log "another update run is in progress; skipping this cycle"; exit 0; }
    run_once
  ) 9>"$LOCK_FILE"
  sleep "$INTERVAL"
done
