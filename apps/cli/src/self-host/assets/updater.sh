#!/bin/sh
# Kortix self-host auto-updater. Runs inside the `kortix-updater` Compose
# service (image: docker:cli, docker socket mounted). Once a day, at a fixed
# local clock time, it pulls this stack's published image tags and, if
# anything actually changed, rolls the stack forward with ZERO downtime: a
# start-first swap per stateless service (new replicas healthy before old
# ones stop). Single-flight via flock so an overlapping run never races.
#
# Resilience invariants this script enforces (see the production-readiness
# audit this file was hardened against — every point below is a fix for a
# confirmed finding, not speculative):
#   1. A failed per-service swap never aborts the rest of the rollout — every
#      changed service is attempted, so the fleet never gets stuck mid-
#      sequence on a MIX of app-tier versions against an already-migrated DB
#      (see the update routine below). A degraded outcome self-heals on the next run
#      because service_up_to_date() always re-detects the stale service.
#   2. A failed run NEVER crashes this standing container — the scheduler
#      loop only ever calls run_locked() through `||`, which neutralizes
#      `set -e` for that call (see the main loop at the bottom). No future
#      nightly is ever silently skipped because today's run errored.
#   3. Every run's outcome (ok/degraded/failed/skipped) is stamped to
#      $STATUS_FILE as JSON — see write_status() — surfaced by `kortix
#      self-host status` and the `report`/`status` subcommands below.
#   4. Drift (declared version vs. what's actually running) is detected
#      explicitly, both as a post-run log check (check_drift) and on demand
#      via the `report` subcommand.
#   5. Superseded images are pruned after a fully successful run only (never
#      after a degraded one, so a rollback target is never removed), and a
#      disk-space preflight runs before any pull.
#   6. The standing scheduler re-execs this very file from disk whenever it
#      changes on disk, so a CLI-shipped fix reaches an already-running
#      container without a manual recreate.
#   7. A lock file (flock) is shared between the nightly scheduler and a
#      manual `kortix self-host update`/`reconcile` run; the loser reports
#      who currently holds it instead of silently no-op'ing.
#   8. A stateful service (e.g. supabase-db) recreated in place is health-
#      gated post-start with an explicit go/no-go log line, never assumed
#      healthy.
#   9. A short post-swap window watches restart counts for a crash loop and
#      stamps a failed/degraded outcome (with a one-line manual rollback
#      command) instead of reporting false success.
#
# Written in POSIX sh (not bash): the `docker:cli` base image is Alpine and
# does not ship bash, and installing it on every container start is an
# avoidable dependency. Every construct below runs under Alpine's busybox ash.
set -eu

STATE_DIR="/state"
LOCK_FILE="$STATE_DIR/updater.lock"
HOLDER_FILE="$STATE_DIR/updater.holder"
BREADCRUMB="$STATE_DIR/deployed-version.json"
STATUS_FILE="$STATE_DIR/update-status.json"
# This container talks to the HOST Docker daemon over the mounted socket
# (Docker-outside-of-Docker), so every relative bind mount THIS COMPOSE FILE
# declares (kong's ./volumes/api/kong.yml, supabase-db's ./volumes/db/*, ...)
# gets resolved by the `docker compose` CLI running in here, and that
# resolved absolute path is what actually gets sent to the host daemon to
# satisfy. It only works if that path also exists on the real host — which is
# exactly what KORTIX_INSTANCE_DIR is: the instance directory bind-mounted at
# the SAME absolute path inside this container as on the host (see the
# kortix-updater service comment in kortix-compose.yml), with working_dir set
# to match. Falls back to the historical /workspace only as a defensive
# default; writeCompose()/normalizeFullSupabaseEnv() (commands/self-host.ts)
# always set KORTIX_INSTANCE_DIR before this container ever runs, so that
# fallback should never actually be exercised.
WORKDIR="${KORTIX_INSTANCE_DIR:-/workspace}"
COMPOSE_FILE="$WORKDIR/docker-compose.yml"
SCRIPT_FILE="$WORKDIR/updater.sh"
PROJECT_NAME="${KORTIX_COMPOSE_PROJECT:-kortix}"
COMPOSE="docker compose --project-name $PROJECT_NAME --env-file $WORKDIR/.env -f $COMPOSE_FILE"

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
CRASH_WATCH_S="${KORTIX_CRASH_WATCH_S:-20}"      # post-swap window to catch a crash-loop
MIN_FREE_DISK_MB="${KORTIX_MIN_FREE_DISK_MB:-2048}"
UPDATE_TIME="${KORTIX_UPDATE_TIME:-02:00}"       # HH:MM, 24h, local to KORTIX_UPDATE_TZ
export TZ="${KORTIX_UPDATE_TZ:-America/New_York}"

mkdir -p "$STATE_DIR"

log() {
  echo "[kortix-updater] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ---- introspection helpers ----

# The image ID (sha256 config digest) a freshly-pulled tag now resolves to.
image_id_of_ref() {
  docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true
}

# The image ref the rendered config expects for ONE service. Never use
# `$COMPOSE config --images <svc>` for this: on the compose builds shipped in
# the docker:cli updater image it prints the service's whole dependency
# closure (its depends_on graph), in graph order — `head -n1` then returns a
# DEPENDENCY's image (caddy "expected" kortix-api, kortix-api "expected"
# kong, …), which made every service look drifted, stamped every update
# DEGRADED, and needlessly recreated stateful Supabase services on each run.
# Parse the service's own `image:` line out of the rendered config instead
# (same busybox-awk approach as publishes_host_port; `config` interpolates
# ${*_IMAGE} from .env, which the raw compose file would not).
service_image_ref() {
  $COMPOSE config 2>/dev/null | awk -v svc="$1" '
    $0 == "  " svc ":" { inside = 1; next }
    inside && /^  [A-Za-z0-9_-]+:/ { exit }
    inside && /^    image:/ { sub(/^    image:[ ]*/, ""); gsub(/"/, ""); print; exit }
  '
}

running_container_ids() {
  $COMPOSE ps --quiet "$1" 2>/dev/null || true
}

container_image_id() {
  docker inspect --format '{{.Image}}' "$1" 2>/dev/null || true
}

restart_count() {
  docker inspect --format '{{.RestartCount}}' "$1" 2>/dev/null || echo 0
}

# Dev mode: `kortix self-host init --local-images` sets KORTIX_IMAGE_PULL=never
# in the instance .env for a locally-built image that isn't on any registry —
# `docker compose pull` would just fail (or silently no-op) against it, so skip
# it entirely and roll using whatever image is already in the local Docker
# engine. Read straight from "$WORKDIR/.env", same as write_status below —
# this script never sees CLI flags, only the env file.
image_pull_mode() {
  grep '^KORTIX_IMAGE_PULL=' "$WORKDIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-
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
# container is running yet (first install). This is also what makes a
# degraded outcome self-healing: whatever failed to swap this run still
# reports "not up to date" on the very next run, with no extra bookkeeping.
service_up_to_date() {
  svc="$1"
  ref=$(service_image_ref "$svc")
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

# One retry of the same swap before this service is reported failed for the
# run — a transient blip (a slow pull finishing late, a momentary health-check
# flake) shouldn't by itself force a degraded outcome when a second attempt
# would have gone through cleanly.
roll_or_recreate_with_retry() {
  svc="$1"
  if roll_or_recreate "$svc"; then
    return 0
  fi
  log "$svc: retrying once before giving up on this run"
  roll_or_recreate "$svc"
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
# with a newer Supabase pin; day to day these images never change. Every
# recreate (including supabase-db) is health-gated: no service is ever
# considered "reconciled" without a post-start go/no-go check, logged
# explicitly either way.
reconcile_stateful_services() {
  all_ok=0
  for svc in $($COMPOSE config --services 2>/dev/null); do
    case "$svc" in
      kortix-api | llm-gateway | frontend | kortix-migrate | kortix-updater) continue ;;
    esac
    service_up_to_date "$svc" && continue
    log "$svc: pinned image changed; recreating (brief blip acceptable)"
    $COMPOSE up -d --no-deps "$svc"
    ids=$(running_container_ids "$svc")
    # shellcheck disable=SC2086
    if wait_healthy $ids; then
      log "$svc: healthy after recreate (go)"
    else
      log "ERROR: $svc did not become healthy after recreate (no-go) — investigate before the next scheduled run retries it"
      all_ok=1
    fi
  done
  return "$all_ok"
}

# Logs one line per service whose running container image doesn't match what
# the rendered .env currently expects — drift is otherwise completely
# invisible (the channel/tag says one thing, the containers run another).
# Also the basis for the `report` subcommand's machine-readable drift array.
check_drift() {
  drifted=0
  for svc in $($COMPOSE config --services 2>/dev/null); do
    case "$svc" in kortix-updater | kortix-migrate) continue ;; esac
    ref=$(service_image_ref "$svc")
    [ -z "$ref" ] && continue
    desired=$(image_id_of_ref "$ref")
    [ -z "$desired" ] && continue
    ids=$(running_container_ids "$svc")
    [ -z "$ids" ] && continue
    for id in $ids; do
      if [ "$(container_image_id "$id")" != "$desired" ]; then
        log "DRIFT: $svc is running an image that does not match the rendered .env (expected $ref)"
        drifted=1
      fi
    done
  done
  return "$drifted"
}

drift_report_json() {
  printf '['
  first=1
  for svc in $($COMPOSE config --services 2>/dev/null); do
    case "$svc" in kortix-updater | kortix-migrate) continue ;; esac
    ref=$(service_image_ref "$svc")
    [ -z "$ref" ] && continue
    desired=$(image_id_of_ref "$ref")
    ids=$(running_container_ids "$svc")
    if [ -z "$ids" ]; then
      state="not-running"
      drift="false"
    else
      state="running"
      drift="false"
      for id in $ids; do
        [ "$(container_image_id "$id")" = "$desired" ] || drift="true"
      done
    fi
    [ "$first" = 1 ] || printf ','
    first=0
    printf '{"service":"%s","expected_image":"%s","state":"%s","drift":%s}' \
      "$(json_escape "$svc")" "$(json_escape "$ref")" "$state" "$drift"
  done
  printf ']'
}

# Disk-space preflight, run before pulling anything. A pull that starts and
# then fails partway through a nearly-full disk is a worse failure mode than
# refusing up front with a clear, stamped error. Checked against $WORKDIR
# rather than the host's real Docker data-root: this container only ever has
# the instance directory bind-mounted at its real host path (see the
# KORTIX_INSTANCE_DIR comment above), and `df` on a bind mount reports the
# underlying HOST filesystem's free space for that mount — an honest proxy on
# the overwhelming majority of self-host boxes (single disk), though not exact
# if an operator deliberately put Docker's data-root on a separate volume.
disk_preflight() {
  avail_kb=$(df -Pk "$WORKDIR" 2>/dev/null | awk 'NR==2{print $4}')
  if [ -z "${avail_kb:-}" ]; then
    log "WARN: could not determine free disk space at $WORKDIR; skipping preflight"
    return 0
  fi
  avail_mb=$((avail_kb / 1024))
  if [ "$avail_mb" -lt "$MIN_FREE_DISK_MB" ]; then
    log "ERROR: only ${avail_mb}MB free at $WORKDIR (floor ${MIN_FREE_DISK_MB}MB, override with KORTIX_MIN_FREE_DISK_MB) — aborting before pulling new images"
    return 1
  fi
  log "disk preflight ok (${avail_mb}MB free at $WORKDIR, floor ${MIN_FREE_DISK_MB}MB)"
}

# Pre-pull sanity check: every rolling + migrate service's image reference
# must actually resolve in the local Docker engine BEFORE migrations touch the
# schema. A pull that silently no-op'd (registry auth expiring, a yanked tag,
# a network blip `docker compose pull` swallowed) must never be discovered
# mid-rollout, after the new schema is already live.
sanity_check_images() {
  ok=0
  for svc in $ROLL_SERVICES $MIGRATE_SERVICE; do
    ref=$(service_image_ref "$svc")
    [ -z "$ref" ] && continue
    if [ -z "$(image_id_of_ref "$ref")" ]; then
      log "ERROR: $svc image '$ref' did not resolve locally after pull (sanity check failed)"
      ok=1
    fi
  done
  return "$ok"
}

# Keeps this stack's own images tidy after a fully successful run only —
# never after a degraded one, so a service still needing a rollback target
# never has it pulled out from under it. Keeps the currently-deployed image
# refs plus the immediately-previous run's, so `kortix self-host rollback
# --release <previous>` never needs to re-pull; everything else this stack
# owns and nothing is still running on is fair game.
gc_images() {
  hist="$STATE_DIR/image-history.log"
  { grep -h '^API_IMAGE=\|^FRONTEND_IMAGE=\|^GATEWAY_IMAGE=' "$WORKDIR/.env" 2>/dev/null | tr '\n' ' '; echo; } >>"$hist"
  tail -n 2 "$hist" >"$hist.tmp" 2>/dev/null && mv "$hist.tmp" "$hist"
  keep_refs=$(sed -E 's/[A-Z_]+=//g' "$hist" 2>/dev/null | tr ' ' '\n' | sed '/^$/d' | sort -u)

  for repo_var in API_IMAGE FRONTEND_IMAGE GATEWAY_IMAGE; do
    ref=$(grep "^${repo_var}=" "$WORKDIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-)
    [ -z "$ref" ] && continue
    repo=$(printf '%s' "$ref" | sed -E 's#:[^/:]+$##')
    [ -z "$repo" ] && continue
    for local_ref in $(docker images --format '{{.Repository}}:{{.Tag}}' "$repo" 2>/dev/null); do
      if printf '%s\n' "$keep_refs" | grep -qxF "$local_ref"; then
        continue
      fi
      log "gc: removing superseded image $local_ref (kept: current + previous for fast rollback)"
      docker rmi "$local_ref" >/dev/null 2>&1 || true
    done
  done
  # Reclaim genuinely dangling, unreferenced layers too.
  docker image prune -f >/dev/null 2>&1 || true
}

# Watches restart counts on the services this run just touched for a short
# window — a health check alone can pass once right after start and then the
# container crash-loops on real traffic/config it never saw until the swap
# completed. Never trust "went healthy once" as the final word.
watch_for_crash_loop() {
  [ $# -eq 0 ] && return 0
  log "watching for crash-loops for ${CRASH_WATCH_S}s: $*"
  before=""
  for svc in "$@"; do
    for id in $(running_container_ids "$svc"); do
      before="$before $svc:$id:$(restart_count "$id")"
    done
  done
  sleep "$CRASH_WATCH_S"
  crashed=""
  for entry in $before; do
    svc=${entry%%:*}
    rest=${entry#*:}
    id=${rest%%:*}
    was=${rest#*:}
    now=$(restart_count "$id")
    if [ "$now" != "$was" ]; then
      crashed="$crashed $svc"
      log "ERROR: $svc ($id) restarted during the post-swap watch window ($was -> $now) — crash-looping"
    fi
  done
  if [ -n "$crashed" ]; then
    # PROJECT_NAME is always "kortix-<instance>" (see composeProject() in
    # commands/self-host.ts) — strip the fixed prefix back off instead of
    # requiring a dedicated instance-name env var just for this message.
    instance_hint="${PROJECT_NAME#kortix-}"
    [ "$instance_hint" = "$PROJECT_NAME" ] && instance_hint="default"
    log "ERROR: crash-loop detected in:$crashed — rollback with: kortix self-host update --release <previous-version> --instance $instance_hint"
    return 1
  fi
  return 0
}

# ---- version / status bookkeeping ----

# The version this run started FROM: the "to" of the last recorded run (or
# "from" if that run never got that far), read back from the status file this
# same script writes. .env's KORTIX_VERSION has ALREADY been rewritten to the
# TARGET version by the CLI (writeEnv) by the time this script ever runs, so
# it can only ever tell us where we're going, never where we came from.
current_version() {
  v=""
  if [ -f "$STATUS_FILE" ]; then
    v=$(sed -n 's/.*"to_version":"\([^"]*\)".*/\1/p' "$STATUS_FILE" | head -n1)
  fi
  if [ -z "$v" ] && [ -f "$BREADCRUMB" ]; then
    v=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$BREADCRUMB" | head -n1)
  fi
  printf '%s' "$v"
}

pending_version() {
  grep '^KORTIX_VERSION=' "$WORKDIR/.env" 2>/dev/null | tail -n1 | cut -d= -f2-
}

# Stamps this run's outcome as JSON — the single source of truth `kortix
# self-host status` reads. outcome is one of: ok | degraded | failed |
# skipped. `services` carries the per-service "svc=ok|failed|unchanged"
# breakdown so a degraded run says exactly which service(s) are still stale.
write_status() {
  outcome="$1"; from="$2"; to="$3"; stage="$4"; detail="$5"
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"outcome":"%s","started_at":"%s","finished_at":"%s","from_version":"%s","to_version":"%s","stage":"%s","detail":"%s","services":"%s"}\n' \
    "$(json_escape "$outcome")" "$(json_escape "${run_started:-$finished}")" "$(json_escape "$finished")" \
    "$(json_escape "$from")" "$(json_escape "$to")" "$(json_escape "$stage")" "$(json_escape "$detail")" \
    "$(json_escape "${service_results:-}")" >"$STATUS_FILE"
  # Legacy breadcrumb (version + timestamp only) kept for anything that might
  # still read it directly off the shared volume.
  printf '{"deployed_at":"%s","version":"%s"}\n' "$finished" "${to:-$from}" >"$BREADCRUMB"
  log "status: $outcome ($from -> $to)${detail:+ — $detail}"
  notify_webhook
}

# Optional, one env var, no vendor integration: if the operator sets
# KORTIX_UPDATE_WEBHOOK_URL, POST this run's status JSON (the exact contents
# of $STATUS_FILE) to it after every run — success, degraded, failed, or
# skipped-by-lock alike — so an operator who wants a push notification can
# wire it to whatever they already use (a generic webhook relay, a Slack
# incoming-webhook URL, their own endpoint, ...) without this script knowing
# or caring which. Best-effort: a failed POST (unreachable URL, timeout) is
# logged but never fails the update itself.
notify_webhook() {
  url="${KORTIX_UPDATE_WEBHOOK_URL:-}"
  [ -z "$url" ] && return 0
  if ! wget -q -O /dev/null -T 10 --header 'Content-Type: application/json' --post-file "$STATUS_FILE" "$url" >/dev/null 2>&1; then
    log "WARN: KORTIX_UPDATE_WEBHOOK_URL POST failed (non-fatal; update outcome above is unaffected)"
  fi
}

perform_update() {
  run_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  from_version=$(current_version)
  service_results=""

  if ! disk_preflight; then
    write_status "failed" "$from_version" "$from_version" "disk-preflight" "insufficient free disk space"
    return 1
  fi

  if [ "$(image_pull_mode)" = "never" ]; then
    log "skipping registry pull (KORTIX_IMAGE_PULL=never)"
  else
    log "pulling images"
    if ! $COMPOSE pull --quiet; then
      write_status "failed" "$from_version" "$from_version" "pull" "docker compose pull failed"
      return 1
    fi
  fi

  # Pre-pull sanity check for every image this run could touch — BEFORE
  # migrations run, so a bad/missing pull is never discovered after the
  # schema has already moved.
  if ! sanity_check_images; then
    write_status "failed" "$from_version" "$from_version" "image-sanity" "one or more pulled images did not resolve locally"
    return 1
  fi

  changed=""
  for svc in $ROLL_SERVICES; do
    service_up_to_date "$svc" || changed="$changed $svc"
  done

  if [ -z "$changed" ]; then
    log "no app-tier image changes; nothing to roll"
    if reconcile_stateful_services; then
      check_drift || true
      write_status "ok" "$from_version" "$from_version" "" ""
      return 0
    else
      check_drift || true
      write_status "degraded" "$from_version" "$from_version" "stateful-recreate" "a stateful service failed its post-recreate health gate"
      return 1
    fi
  fi
  log "changed:$changed"
  to_version=$(pending_version)
  overall_ok=0

  if [ "${KORTIX_ALLOW_DOWNTIME:-0}" = "1" ]; then
    if downtime_swap; then
      for svc in $ROLL_SERVICES; do service_results="$service_results $svc=ok"; done
    else
      for svc in $ROLL_SERVICES; do service_results="$service_results $svc=failed"; done
      write_status "failed" "$from_version" "$to_version" "downtime-swap" "migration or app-tier start failed during the planned-downtime path; previous version may not be serving — investigate immediately"
      return 1
    fi
  else
    # Migrate to completion BEFORE any service moves — a nonzero exit aborts
    # here with every running container untouched.
    if ! run_migrate; then
      write_status "failed" "$from_version" "$to_version" "migrate" "migration failed; nothing was swapped, previous version still serving"
      return 1
    fi
    # Attempt EVERY changed service even if an earlier one fails. This is the
    # core fix for the mixed-version bug class: a failed swap must never
    # abort the remaining services mid-sequence (each one is already
    # health-gated on its own — see roll_service/recreate_service — so the
    # worst case per service is "still on the old image", never "half
    # started"). The run ends DEGRADED, loudly, rather than silently mixed.
    for svc in $ROLL_SERVICES; do
      case " $changed " in
        *" $svc "*)
          if roll_or_recreate_with_retry "$svc"; then
            service_results="$service_results $svc=ok"
          else
            service_results="$service_results $svc=failed"
            overall_ok=1
            log "ERROR: $svc rollout failed after retry; continuing with the remaining services instead of aborting (degraded, not mixed-and-silent)"
          fi
          ;;
        *)
          log "$svc: unchanged; skipping"
          service_results="$service_results $svc=unchanged"
          ;;
      esac
    done
  fi

  reconcile_stateful_services || overall_ok=1
  check_drift || true

  touched=""
  for r in $service_results; do
    case "$r" in *=ok) touched="$touched ${r%%=*}" ;; esac
  done
  # shellcheck disable=SC2086
  watch_for_crash_loop $touched || overall_ok=1

  if [ "$overall_ok" = 0 ]; then
    gc_images
    write_status "ok" "$from_version" "$to_version" "" ""
    log "update complete ($from_version -> $to_version)"
    return 0
  else
    write_status "degraded" "$from_version" "$to_version" "swap" "$service_results"
    log "update finished DEGRADED ($from_version -> $to_version); the next scheduled run (or a manual \`kortix self-host update\`) will retry the stale service(s) automatically"
    return 1
  fi
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

# Single-flight lock shared by the nightly scheduler and a manual `kortix
# self-host update`/`reconcile` run (both ultimately call this). $1 is a
# label ("nightly"/"manual") only used for the holder-info file, so the loser
# of a race can say who currently holds it instead of quietly no-op'ing.
# Exit codes: 0 = ran to completion (ok or handled failure already stamped),
# 75 = lock contention (borrowed from sysexits.h EX_TEMPFAIL) — the caller
# (selfHostUpdate in commands/self-host.ts) treats this distinctly from a
# real failure.
run_locked() {
  kind="${1:-nightly}"
  (
    if ! flock -n 9; then
      holder=$(cat "$HOLDER_FILE" 2>/dev/null || echo "unknown")
      log "another update run is already in progress (${holder}); skipping this ${kind} run"
      write_status "skipped" "$(current_version)" "$(pending_version)" "lock" "another run in progress: ${holder}"
      exit 75
    fi
    printf 'kind=%s pid=%s host=%s since=%s\n' "$kind" "$$" "$(hostname 2>/dev/null || echo unknown)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$HOLDER_FILE"
    rc=0
    perform_update || rc=$?
    rm -f "$HOLDER_FILE" 2>/dev/null || true
    exit "$rc"
  ) 9>"$LOCK_FILE"
}

# sha256sum ships via the busybox coreutils applet on the docker:cli (Alpine)
# base image; fall back to md5sum, then to a size+mtime proxy, so a truly
# minimal base can't make self-update silently never fire.
self_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  elif command -v md5sum >/dev/null 2>&1; then
    md5sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    stat -c '%Y-%s' "$1" 2>/dev/null || true
  fi
}

# The standing scheduler container only ever reads this file once, at
# container start (the entrypoint's `exec ... ./updater.sh`). Without this
# check, a CLI-shipped fix to this very script only reaches an already-running
# instance the next time its container is recreated — never on its own. A
# plain `kortix self-host update` always rewrites this file from the CLI's
# embedded copy first (see writeKortixRuntimeAssets in compose-assets.ts), so
# comparing the on-disk hash at the top of every loop iteration and re-exec'ing
# into the current file when it changed is enough to pick that up immediately.
maybe_reexec_self() {
  new_hash=$(self_hash "$SCRIPT_FILE")
  if [ -n "$new_hash" ] && [ -n "${CURRENT_HASH:-}" ] && [ "$new_hash" != "$CURRENT_HASH" ]; then
    log "updater.sh changed on disk; re-executing the updated script"
    exec /bin/sh "$SCRIPT_FILE" "$@"
  fi
}

# `updater.sh once` runs a single update pass right now and exits — this is
# what `kortix self-host update`/`reconcile` shells out to, so a manual,
# on-demand update goes through the exact same zero-downtime start-first path
# as the nightly schedule (and ignores KORTIX_AUTO_UPDATE: an explicit manual
# request always runs).
if [ "${1:-}" = "once" ]; then
  log "manual run (once)"
  rc=0
  run_locked manual || rc=$?
  exit "$rc"
fi

# `updater.sh status` / `updater.sh report`: read-only, no lock needed — used
# by `kortix self-host status` to surface the last outcome plus a live drift
# check without running an update.
if [ "${1:-}" = "status" ]; then
  cat "$STATUS_FILE" 2>/dev/null || echo '{"outcome":"never-run"}'
  exit 0
fi
if [ "${1:-}" = "report" ]; then
  status_json=$(cat "$STATUS_FILE" 2>/dev/null || true)
  [ -z "$status_json" ] && status_json='{"outcome":"never-run"}'
  if (flock -n 8 || exit 1) 8>"$LOCK_FILE" 2>/dev/null; then
    locked=false
  else
    locked=true
  fi
  holder=$(cat "$HOLDER_FILE" 2>/dev/null || echo "")
  printf '{"status":%s,"drift":%s,"lock":{"locked":%s,"holder":"%s"}}\n' \
    "$status_json" "$(drift_report_json)" "$locked" "$(json_escape "$holder")"
  exit 0
fi

CURRENT_HASH=$(self_hash "$SCRIPT_FILE")
log "starting (schedule=${UPDATE_TIME} ${TZ}, auto_update=${KORTIX_AUTO_UPDATE:-true})"
while true; do
  maybe_reexec_self "$@"
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
  maybe_reexec_self "$@"
  # NEVER let a failed run exit this loop/container: `set -e` would otherwise
  # kill the standing scheduler on any nonzero exit from a bare statement — the
  # `||` below is load-bearing, not decorative. This is the single fix for
  # "one bad night = no future nightlies, silently".
  run_locked nightly || log "scheduled run did not complete cleanly (see \`kortix self-host status\`); will retry at the next scheduled window"
  # Guard against a run that returns fast (e.g. a parse error) turning this
  # into a tight loop: always land back at the top of the daily wait.
  sleep 1
done
