#!/usr/bin/env bash

# Build-time cache warming only. A failure here must not prevent the sandbox
# image from building; the same initialization will happen on first boot.
set +e

mode="${1:-}"
cleanup="${2:-targeted}"

stop_opencode() {
  if [ -n "${oc_pid:-}" ]; then
    kill "$oc_pid" 2>/dev/null
    wait "$oc_pid" 2>/dev/null
  fi
}

warm_migration() {
  mkdir -p "$HOME/.local/share" "$HOME/.config" "$HOME/.cache"
  opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/oc-bake.log 2>&1 &
  oc_pid=$!
  for _ in $(seq 1 180); do
    curl -s -o /dev/null -m 2 http://127.0.0.1:4096/ && break
    kill -0 "$oc_pid" 2>/dev/null || break
    sleep 1
  done
  sleep 3
  stop_opencode
  echo "=== migration-bake: opencode data dir ==="
  ls -laR "$HOME/.local/share/opencode" 2>/dev/null | head -40
  echo "=== migration-bake: opencode log tail ==="
  tail -25 /tmp/oc-bake.log
  rm -f /tmp/oc-bake.log
}

warm_instance() {
  mkdir -p /workspace/.kortix
  staged_starter_config=0
  if [ ! -d /workspace/.kortix/opencode ]; then
    cp -a /opt/kortix/warm-config/.kortix/opencode /workspace/.kortix/opencode
    staged_starter_config=1
  fi
  rm -rf /workspace/.kortix/opencode/node_modules
  ln -s /opt/kortix/opencode-config-deps/node_modules /workspace/.kortix/opencode/node_modules
  export OPENCODE_CONFIG_DIR=/workspace/.kortix/opencode
  cd /workspace || return 0
  opencode serve --port 4096 --hostname 127.0.0.1 >/tmp/oc-warm.log 2>&1 &
  oc_pid=$!
  ready=0
  for _ in $(seq 1 300); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:4096/session?directory=/workspace" 2>/dev/null)
    case "$code" in 200|204|301|302) ready=1; break ;; esac
    kill -0 "$oc_pid" 2>/dev/null || break
    sleep 1
  done
  echo "=== instance-warm: ready=$ready ==="
  stop_opencode

  case "$cleanup" in
    keep) echo "warm-repo: keeping baked /workspace checkout" ;;
    wipe) find /workspace -mindepth 1 -delete 2>/dev/null ;;
    targeted)
      [ "$staged_starter_config" = 1 ] && rm -rf /workspace/.kortix/opencode
      rmdir /workspace/.kortix 2>/dev/null
      ;;
    *) echo "unknown instance cleanup mode: $cleanup" >&2 ;;
  esac

  rm -rf /opt/kortix/warm-config
  echo "=== instance-warm: opencode log tail ==="
  tail -20 /tmp/oc-warm.log
  rm -f /tmp/oc-warm.log
}

trap stop_opencode EXIT
case "$mode" in
  migration) warm_migration ;;
  instance) warm_instance ;;
  *) echo "usage: $0 {migration|instance [keep|wipe|targeted]}" >&2 ;;
esac

exit 0
