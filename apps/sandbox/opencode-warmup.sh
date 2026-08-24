#!/usr/bin/env bash

# Build-time cache warming only. A successful image must contain an OpenCode
# runtime that completed both database migration and project initialization.
set -u

mode="${1:-}"
cleanup="${2:-targeted}"
migration_attempts="${OPENCODE_WARMUP_MIGRATION_ATTEMPTS:-180}"
instance_attempts="${OPENCODE_WARMUP_INSTANCE_ATTEMPTS:-300}"
poll_seconds="${OPENCODE_WARMUP_POLL_SECONDS:-1}"
settle_seconds="${OPENCODE_WARMUP_SETTLE_SECONDS:-3}"
stop_attempts="${OPENCODE_WARMUP_STOP_ATTEMPTS:-50}"
stop_poll_seconds="${OPENCODE_WARMUP_STOP_POLL_SECONDS:-0.1}"
launch_attempts="${OPENCODE_WARMUP_LAUNCH_ATTEMPTS:-3}"
workspace="${KORTIX_WARMUP_WORKSPACE:-/workspace}"
warm_config_root="${KORTIX_WARMUP_CONFIG_ROOT:-/opt/kortix/warm-config}"
config_deps="${KORTIX_WARMUP_CONFIG_DEPS:-/opt/kortix/opencode-config-deps/node_modules}"
oc_pid=""
oc_process_group=0

start_opencode() {
  local log_path="$1"
  shift

  # OpenCode can launch helpers while it initializes. Give the complete tree a
  # private process group when setsid is available, so image builds never leave
  # a helper behind after the warm-up finishes.
  if command -v setsid >/dev/null 2>&1; then
    setsid opencode "$@" >"$log_path" 2>&1 &
    oc_process_group=1
  else
    opencode "$@" >"$log_path" 2>&1 &
    oc_process_group=0
  fi
  oc_pid=$!
}

stop_opencode() {
  if [ -n "$oc_pid" ]; then
    local target="$oc_pid"
    local attempt=0
    if [ "$oc_process_group" = 1 ]; then
      target="-$oc_pid"
    fi

    kill -TERM -- "$target" 2>/dev/null || true
    while kill -0 -- "$target" 2>/dev/null && [ "$attempt" -lt "$stop_attempts" ]; do
      sleep "$stop_poll_seconds"
      attempt=$((attempt + 1))
    done
    if kill -0 -- "$target" 2>/dev/null; then
      echo "opencode warm-up did not stop after ${stop_attempts} attempts; forcing process group shutdown" >&2
      kill -KILL -- "$target" 2>/dev/null || true
      # Keep wait bounded even if a non-util-linux setsid implementation did
      # not make the background PID the process-group leader.
      kill -KILL -- "$oc_pid" 2>/dev/null || true
    fi
    wait "$oc_pid" 2>/dev/null
    oc_pid=""
    oc_process_group=0
  fi
}

print_log_tail() {
  local label="$1"
  local log_path="$2"
  echo "=== ${label}: opencode log tail ==="
  tail -25 "$log_path" 2>/dev/null
}

allocate_opencode_port() {
  # OpenCode treats --port 0 as its fixed default (4096), so ask the kernel for
  # a currently free loopback port. Perl is already in the Ubuntu runtime and
  # avoids triggering the lazy Python installer during an image build.
  if command -v perl >/dev/null 2>&1; then
    perl -MIO::Socket::INET -e \
      '$s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>0,Proto=>"tcp",Listen=>1) or die $!; print $s->sockport'
    return
  fi
  python3 - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

wait_for_opencode() {
  local log_path="$1"
  local request_path="$2"
  local attempts="$3"
  local expected_port="$4"
  local code
  local attempt
  local listener_port=""

  for attempt in $(seq 1 "$attempts"); do
    if [ -z "$listener_port" ]; then
      listener_port="$(
        sed -n 's#.*http://127\.0\.0\.1:\([0-9][0-9]*\).*#\1#p' "$log_path" 2>/dev/null |
          tail -n 1
      )"
    fi
    # Curl only after THIS process logs the exact port it was assigned. If a
    # concurrent process wins a rare bind race, its healthy endpoint cannot be
    # mistaken for this warm-up's readiness.
    if [ "$listener_port" = "$expected_port" ]; then
      code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 \
        "http://127.0.0.1:${expected_port}${request_path}" 2>/dev/null || true)
      case "$code" in
        200|204|301|302) return 0 ;;
      esac
    fi
    kill -0 "$oc_pid" 2>/dev/null || return 1
    sleep "$poll_seconds"
  done

  return 1
}

start_ready_opencode() {
  local log_path="$1"
  local request_path="$2"
  local attempts="$3"
  local launch
  local port

  for launch in $(seq 1 "$launch_attempts"); do
    port="$(allocate_opencode_port)" || return 1
    rm -f "$log_path"
    start_opencode "$log_path" serve --port "$port" --hostname 127.0.0.1
    if wait_for_opencode "$log_path" "$request_path" "$attempts" "$port"; then
      return 0
    fi
    stop_opencode
    if [ "$launch" -lt "$launch_attempts" ]; then
      echo "opencode warm-up launch ${launch}/${launch_attempts} failed; retrying on a new port" >&2
    fi
  done

  return 1
}

warm_migration() {
  local log_path="/tmp/oc-bake-$$.log"
  local migration_dir="/tmp/kortix-opencode-migration-$$"

  mkdir -p "$HOME/.local/share" "$HOME/.config" "$HOME/.cache" "$migration_dir" || return 1
  rm -f "$log_path"
  # Port 4096 is shared when a provider runs concurrent Podman builds in one
  # network namespace. Use a kernel-assigned high port. A fixed port can make
  # curl hit another build's healthy server while this process exits ServeError.
  if ! start_ready_opencode \
    "$log_path" \
    "/session?directory=$migration_dir" \
    "$migration_attempts"; then
    echo "opencode migration warm-up did not become ready after ${migration_attempts} attempts" >&2
    stop_opencode
    print_log_tail migration-bake "$log_path"
    rm -rf "$migration_dir"
    rm -f "$log_path"
    return 1
  fi
  sleep "$settle_seconds"
  if ! kill -0 "$oc_pid" 2>/dev/null; then
    echo "opencode migration warm-up exited after its readiness response" >&2
    print_log_tail migration-bake "$log_path"
    rm -rf "$migration_dir"
    rm -f "$log_path"
    return 1
  fi
  stop_opencode
  echo "=== migration-bake: opencode data dir ==="
  ls -laR "$HOME/.local/share/opencode" 2>/dev/null | head -40
  print_log_tail migration-bake "$log_path"
  rm -rf "$migration_dir"
  rm -f "$log_path"
}

warm_instance() {
  local log_path="/tmp/oc-warm-$$.log"
  local ready=0
  local staged_starter_config=0
  local repo_head=""
  local repo_kortix_backup="/tmp/kortix-opencode-repo-config-$$"
  local cleanup_ok=1

  case "$cleanup" in
    keep|repo|wipe|targeted) ;;
    *)
      echo "unknown instance cleanup mode: $cleanup" >&2
      return 2
      ;;
  esac

  if [ "$cleanup" = repo ]; then
    repo_head="$(git -C "$workspace" rev-parse --verify HEAD 2>/dev/null)" || {
      echo "repo cleanup requires a Git checkout at $workspace" >&2
      return 1
    }
    if [ -n "$(git -C "$workspace" status --porcelain=v1 --untracked-files=all)" ] ||
      [ -n "$(git -C "$workspace" clean -ndx)" ]; then
      echo "repo cleanup requires a pristine baked checkout" >&2
      return 1
    fi
    if [ ! -d "$warm_config_root/.kortix/opencode" ]; then
      echo "missing staged OpenCode warm-up config" >&2
      return 1
    fi
    rm -rf -- "$repo_kortix_backup" || return 1
    if [ -e "$workspace/.kortix" ] || [ -L "$workspace/.kortix" ]; then
      mv -- "$workspace/.kortix" "$repo_kortix_backup" || return 1
    fi
  fi

  if [ "$cleanup" = repo ]; then
    rm -rf "$warm_config_root/.kortix/opencode/node_modules" || return 1
    ln -s "$config_deps" "$warm_config_root/.kortix/opencode/node_modules" || return 1
    export OPENCODE_CONFIG_DIR="$warm_config_root/.kortix/opencode"
    export OPENCODE_DISABLE_PROJECT_CONFIG=1
  else
    mkdir -p "$workspace/.kortix" || return 1
    if [ ! -d "$workspace/.kortix/opencode" ]; then
      if [ ! -d "$warm_config_root/.kortix/opencode" ]; then
        echo "missing staged OpenCode warm-up config" >&2
        return 1
      fi
      cp -a "$warm_config_root/.kortix/opencode" "$workspace/.kortix/opencode" || return 1
      staged_starter_config=1
    fi
    rm -rf "$workspace/.kortix/opencode/node_modules" || return 1
    ln -s "$config_deps" "$workspace/.kortix/opencode/node_modules" || return 1
    export OPENCODE_CONFIG_DIR="$workspace/.kortix/opencode"
  fi
  cd "$workspace" || return 1
  rm -f "$log_path"
  if start_ready_opencode \
    "$log_path" \
    '/session?directory=/workspace' \
    "$instance_attempts"; then
    ready=1
  fi
  echo "=== instance-warm: ready=$ready ==="
  stop_opencode

  case "$cleanup" in
    keep) echo "warm-repo: keeping baked $workspace checkout" ;;
    repo)
      git -C "$workspace" reset --hard "$repo_head" >/dev/null || cleanup_ok=0
      git -C "$workspace" clean -ffdx >/dev/null || cleanup_ok=0
      if [ "$(git -C "$workspace" rev-parse --verify HEAD 2>/dev/null)" != "$repo_head" ] ||
        [ -n "$(git -C "$workspace" status --porcelain=v1 --untracked-files=all)" ] ||
        [ -n "$(git -C "$workspace" clean -ndx)" ]; then
        cleanup_ok=0
      fi
      if [ "$cleanup_ok" = 1 ]; then
        rm -rf -- "$repo_kortix_backup" || cleanup_ok=0
      fi
      ;;
    wipe) find "$workspace" -mindepth 1 -delete 2>/dev/null ;;
    targeted)
      [ "$staged_starter_config" = 1 ] && rm -rf "$workspace/.kortix/opencode"
      rmdir "$workspace/.kortix" 2>/dev/null
      ;;
  esac

  rm -rf "$warm_config_root"
  print_log_tail instance-warm "$log_path"
  rm -f "$log_path"

  if [ "$cleanup_ok" != 1 ]; then
    echo "repo cleanup did not restore the baked checkout exactly" >&2
    return 1
  fi

  if [ "$ready" != 1 ]; then
    echo "opencode instance warm-up did not become ready after ${instance_attempts} attempts" >&2
    return 1
  fi
}

trap stop_opencode EXIT
status=0
case "$mode" in
  migration) warm_migration || status=$? ;;
  instance) warm_instance || status=$? ;;
  *)
    echo "usage: $0 {migration|instance [keep|repo|wipe|targeted]}" >&2
    status=2
    ;;
esac

exit "$status"
