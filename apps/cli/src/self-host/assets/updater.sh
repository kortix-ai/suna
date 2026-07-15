#!/bin/sh
# Kortix self-host auto-updater. Runs inside the `kortix-updater` Compose
# service (image: docker:cli, docker socket mounted). Once a day, at a fixed
# local clock time, it pulls this stack's published image tags and, if
# anything actually changed, rolls the stack forward with ZERO downtime: a
# start-first swap per stateless service (new replicas healthy before old
# ones stop). A failed swap leaves the previous version serving and exits
# nonzero. Single-flight via flock so an overlapping run never races.
#
# Written in POSIX sh (not bash): the `docker:cli` base image is Alpine and
# does not ship bash, and installing it on every container start is an
# avoidable dependency. Every construct below runs under Alpine's busybox ash.
set -eu

STATE_DIR="/state"
LOCK_FILE="$STATE_DIR/updater.lock"
BREADCRUMB="$STATE_DIR/deployed-version.json"
COMPOSE_FILE="/workspace/docker-compose.yml"
PROJECT_NAME="${KORTIX_COMPOSE_PROJECT:-kortix}"
COMPOSE="docker compose --project-name $PROJECT_NAME --env-file /workspace/.env -f $COMPOSE_FILE"

# The stateless app-tier services rolled start-first, in order. Must match
# ROLLING_APP_SERVICES in compose-assets.ts.
ROLL_SERVICES="kortix-api llm-gateway frontend"
MIGRATE_SERVICE="kortix-migrate"

# Target replica count is decided once, at render time, by whether a domain
# (and therefore Caddy) is configured — see applyReplicaTopology() in
# compose-assets.ts. We just read it back so this script never has to
# re-derive prod-vs-laptop topology itself.
TARGET_REPLICAS="${KORTIX_APP_REPLICAS:-1}"

ROLLOUT_TIMEOUT="${KORTIX_ROLLOUT_TIMEOUT:-300}" # seconds to wait for new replicas to go healthy
HEALTH_POLL_S=3
UPDATE_TIME="${KORTIX_UPDATE_TIME:-02:00}"       # HH:MM, 24h, local to KORTIX_UPDATE_TZ
export TZ="${KORTIX_UPDATE_TZ:-America/New_York}"

mkdir -p "$STATE_DIR"

log() {
  echo "[kortix-updater] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# ---- introspection helpers ----

# The image ID (sha256 config digest) a freshly-pulled tag now resolves to.
image_id_of_ref() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

running_container_ids() {
  $COMPOSE ps --quiet "$1" 2>/dev/null || true
}

container_image_id() {
  docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true
}

# healthy|running (both count as "up"), or anything else counts as not-ready.
container_health() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$1" 2>/dev/null || echo gone
}

# Does the rendered compose file publish a host port for this service? Laptop
# mode does (single replica on a loopback port); prod mode never does (Caddy
# reaches every replica by Docker DNS). Checked directly against the static,
# generator-produced file rather than a live container so it also holds on a
# service's very first start (no running container to inspect yet).
publishes_host_port() {
  awk -v svc="$1" '
    $0 == "  " svc ":" { inside = 1; next }
    inside && /^  [A-Za-z0-9_-]+:/ { exit }
    inside && /^    ports:/ { found = 1 }
    END { exit !found }
  ' "$COMPOSE_FILE"
}

# True (exit 0) when every running container of $1 is already on the
# freshly-pulled image. False when it needs a (re)start, including when no
# container is running yet (first install).
service_up_to_date() {
  svc="$1"
  ref=$($COMPOSE config --images "$svc" 2>/dev/null | head -n1)
  [ -z "$ref" ] && return 0
  desired=$(image_id_of_ref "$ref")
  [ -z "$desired" ] && return 0
  ids=$(running_container_ids "$svc")
  [ -z "$ids" ] && return 1
  for id in $ids; do
    [ "$(container_image_id "$id")" = "$desired" ] || return 1
  done
  return 0
}

# Poll until every given container id is healthy/running, or the timeout
# elapses, or one of them goes visibly bad (unhealthy/exited/dead/gone).
wait_healthy() {
  deadline=$(($(date +%s) + ROLLOUT_TIMEOUT))
  while :; do
    all_ok=1
    for id in "$@"; do
      case "$(container_health "$id")" in
        healthy | running) ;;
        unhealthy | exited | dead | gone) return 1 ;;
        *) all_ok=0 ;;
      esac
    done
    [ "$all_ok" = 1 ] && return 0
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep "$HEALTH_POLL_S"
  done
}

remove_containers() {
  [ $# -gt 0 ] && docker rm --force --volumes "$@" >/dev/null 2>&1
  return 0
}

# Start-first rolling swap for one stateless service: bring the target replica
# count up on the new image alongside the untouched old containers, wait for
# ONLY the new ones to go healthy, then stop+remove the old ones. If the new
# containers never become healthy, remove THEM instead and leave the old
# ones serving — never below target healthy, deploy fails loudly.
roll_service() {
  svc="$1"
  old_ids=$(running_container_ids "$svc")
  old_count=0
  for _id in $old_ids; do old_count=$((old_count + 1)); done

  scaled=$((old_count + TARGET_REPLICAS))
  log "$svc: starting $TARGET_REPLICAS new replica(s) alongside $old_count existing (start-first, scale=$scaled)"
  $COMPOSE up -d --no-deps --no-recreate --scale "$svc=$scaled" "$svc"

  # `running_container_ids` output is newline-separated; deliberately NOT
  # collapsed to a single-line string for a `case " $old_ids " in *" $id "*)`
  # substring test — that comparison is a trap here (a newline instead of a
  # space between two ids makes an id that is genuinely present fail to
  # match, misclassifying an OLD container as "new" and destroying it below).
  # A plain nested membership loop word-splits on any whitespace (including
  # newlines) and has no such edge case.
  new_ids=""
  for id in $(running_container_ids "$svc"); do
    is_old=0
    for oid in $old_ids; do
      if [ "$id" = "$oid" ]; then
        is_old=1
        break
      fi
    done
    [ "$is_old" = 0 ] && new_ids="$new_ids $id"
  done
  if [ -z "$new_ids" ]; then
    log "ERROR: $svc start-first roll started no new containers"
    return 1
  fi

  # shellcheck disable=SC2086
  if wait_healthy $new_ids; then
    log "$svc: new replica(s) healthy; stopping the old ones"
    # shellcheck disable=SC2086
    remove_containers $old_ids
    $COMPOSE up -d --no-deps --no-recreate --scale "$svc=$TARGET_REPLICAS" "$svc"
    log "$svc: rolled to the new image ($TARGET_REPLICAS replica(s))"
  else
    log "ERROR: $svc new replica(s) never became healthy; removing them and keeping the previous version serving"
    # shellcheck disable=SC2086
    remove_containers $new_ids
    return 1
  fi
}

# Laptop-mode fallback for a service that publishes a host port: two replicas
# would collide on that port, so a true start-first swap is impossible. Do a
# plain in-place recreate instead — a brief blip, acceptable on a laptop/dev
# box with no load balancer in front of it anyway.
recreate_service() {
  svc="$1"
  log "$svc: publishes a host port (laptop mode); recreating in place (brief blip)"
  $COMPOSE up -d --no-deps "$svc"
  ids=$(running_container_ids "$svc")
  # shellcheck disable=SC2086
  if ! wait_healthy $ids; then
    log "ERROR: $svc did not become healthy after recreate"
    return 1
  fi
}

roll_or_recreate() {
  svc="$1"
  if publishes_host_port "$svc"; then
    recreate_service "$svc"
  else
    roll_service "$svc"
  fi
}

run_migrate() {
  log "running database migrations ($MIGRATE_SERVICE, one-shot)"
  if ! $COMPOSE run --rm --no-deps "$MIGRATE_SERVICE"; then
    log "ERROR: migration failed; aborting — nothing was swapped"
    return 1
  fi
}

# Escape hatch for a release whose migration is NOT backward-compatible: the
# old app must not run against the new schema even briefly, so this trades a
# short, honest downtime window for correctness. Opt-in only
# (KORTIX_ALLOW_DOWNTIME=1) — intended for a planned maintenance window.
downtime_swap() {
  log "KORTIX_ALLOW_DOWNTIME=1: stopping the app tier for a brief maintenance window"
  # shellcheck disable=SC2086
  $COMPOSE rm --stop --force $ROLL_SERVICES
  run_migrate || return 1
  for svc in $ROLL_SERVICES; do
    log "$svc: starting on the new image"
    $COMPOSE up -d --no-deps --scale "$svc=$TARGET_REPLICAS" "$svc"
  done
}

# Supabase (and Caddy) are not rolled start-first — they are stateful or a
# single edge terminator — so a pinned-image bump just recreates them in
# place. This only fires when the operator has regenerated docker-compose.yml
# with a newer Supabase pin; day to day these images never change.
reconcile_stateful_services() {
  for svc in $($COMPOSE config --services 2>/dev/null); do
    case "$svc" in
      kortix-api | llm-gateway | frontend | kortix-migrate | kortix-updater) continue ;;
    esac
    service_up_to_date "$svc" && continue
    log "$svc: pinned image changed; recreating (brief blip acceptable)"
    $COMPOSE up -d --no-deps "$svc"
  done
}

write_breadcrumb() {
  version=$(grep '^KORTIX_VERSION=' /workspace/.env | tail -n1 | cut -d= -f2-)
  printf '{"deployed_at":"%s","version":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${version:-unknown}" >"$BREADCRUMB"
  log "update complete (version=${version:-unknown})"
}

perform_update() {
  log "pulling images"
  $COMPOSE pull --quiet

  changed=""
  for svc in $ROLL_SERVICES; do
    service_up_to_date "$svc" || changed="$changed $svc"
  done

  if [ -z "$changed" ]; then
    log "no app-tier image changes; nothing to roll"
    reconcile_stateful_services
    return 0
  fi
  log "changed:$changed"

  if [ "${KORTIX_ALLOW_DOWNTIME:-0}" = "1" ]; then
    downtime_swap || return 1
  else
    # Migrate to completion BEFORE any service moves — a nonzero exit aborts
    # here with every running container untouched.
    run_migrate || return 1
    for svc in $ROLL_SERVICES; do
      case " $changed " in
        *" $svc "*) roll_or_recreate "$svc" || { log "ERROR: $svc rollout failed; leaving remaining services untouched"; return 1; } ;;
        *) log "$svc: unchanged; skipping" ;;
      esac
    done
  fi

  reconcile_stateful_services
  write_breadcrumb
}

# Seconds until the next occurrence of $UPDATE_TIME (HH:MM) in $TZ, today if
# still ahead of now, otherwise tomorrow. Re-parses "<date> HH:MM" from
# scratch for whichever calendar day it lands on, so the local zone's offset
# (and DST) for THAT day is applied correctly rather than assuming a flat
# 24h/86400s difference.
next_run_epoch() {
  now=$(date +%s)
  today=$(date +%Y-%m-%d)
  target=$(date -d "${today} ${UPDATE_TIME}:00" +%s 2>/dev/null) || target=""
  if [ -z "$target" ]; then
    log "WARN: could not parse KORTIX_UPDATE_TIME='${UPDATE_TIME}'; defaulting to 02:00"
    UPDATE_TIME="02:00"
    target=$(date -d "${today} ${UPDATE_TIME}:00" +%s)
  fi
  if [ "$target" -le "$now" ]; then
    tomorrow=$(date -d "@$((now + 86400))" +%Y-%m-%d)
    target=$(date -d "${tomorrow} ${UPDATE_TIME}:00" +%s)
  fi
  echo "$target"
}

run_locked() {
  (
    flock -n 9 || { log "another update run is in progress; skipping"; exit 0; }
    perform_update
  ) 9>"$LOCK_FILE"
}

# `updater.sh once` runs a single update pass right now and exits — this is
# what `kortix self-host update`/`reconcile` shells out to, so a manual,
# on-demand update goes through the exact same zero-downtime start-first path
# as the nightly schedule (and ignores KORTIX_AUTO_UPDATE: an explicit manual
# request always runs).
if [ "${1:-}" = "once" ]; then
  log "manual run (once)"
  run_locked
  exit 0
fi

log "starting (schedule=${UPDATE_TIME} ${TZ}, auto_update=${KORTIX_AUTO_UPDATE:-true})"
while true; do
  if [ "${KORTIX_AUTO_UPDATE:-true}" != "true" ]; then
    log "KORTIX_AUTO_UPDATE is not true; idling (manual updater.sh once / kortix self-host update still works)"
    sleep "${KORTIX_IDLE_POLL_S:-3600}"
    continue
  fi
  next=$(next_run_epoch)
  wait_s=$((next - $(date +%s)))
  [ "$wait_s" -lt 0 ] && wait_s=0
  log "next scheduled run: $(date -d "@$next" '+%Y-%m-%d %H:%M %Z') (sleeping ${wait_s}s)"
  sleep "$wait_s"
  run_locked
  # Guard against a run that returns fast (e.g. a parse error) turning this
  # into a tight loop: always land back at the top of the daily wait.
  sleep 1
done
