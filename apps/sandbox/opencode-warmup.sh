#!/usr/bin/env bash

# Build-time cache warming only. A failure here must not prevent the sandbox
# image from building; the same initialization will happen on first boot.
set +e

mode="${1:-}"
cleanup="${2:-targeted}"
oc_read_fd=""
oc_write_fd=""
oc_pipe_dir=""

stop_opencode() {
  if [ -n "$oc_write_fd" ]; then
    eval "exec ${oc_write_fd}>&-" 2>/dev/null
    oc_write_fd=""
  fi
  if [ -n "$oc_read_fd" ]; then
    eval "exec ${oc_read_fd}<&-" 2>/dev/null
    oc_read_fd=""
  fi
  if [ -n "${oc_pid:-}" ]; then
    kill "$oc_pid" 2>/dev/null
    wait "$oc_pid" 2>/dev/null
    oc_pid=""
  fi
  if [ -n "$oc_pipe_dir" ]; then
    rm -rf "$oc_pipe_dir"
    oc_pipe_dir=""
  fi
}

await_acp_response() {
  response_id="$1"
  while IFS= read -r -t 300 -u "$oc_read_fd" line; do
    compact="${line//[[:space:]]/}"
    case "$compact" in
      *"\"id\":\"${response_id}\""*)
        case "$compact" in
          *'"error":'*) return 1 ;;
          *)
            printf 'ACP response received: %s\n' "$response_id"
            return 0
            ;;
        esac
        ;;
    esac
  done
  return 1
}

warm_acp() {
  cwd="$1"
  log_path="$2"
  mkdir -p "$cwd"
  oc_pipe_dir="$(mktemp -d /tmp/kortix-opencode-acp.XXXXXX)"
  mkfifo "$oc_pipe_dir/in" "$oc_pipe_dir/out"
  opencode acp \
    --port 4096 \
    --hostname 127.0.0.1 \
    --cwd "$cwd" \
    <"$oc_pipe_dir/in" >"$oc_pipe_dir/out" 2>"$log_path" &
  oc_pid=$!

  # Connect both FIFO pairs before the first ACP request.
  exec 8>"$oc_pipe_dir/in"
  oc_write_fd=8
  exec 9<"$oc_pipe_dir/out"
  oc_read_fd=9

  printf '%s\n' \
    '{"jsonrpc":"2.0","id":"warmup:initialize","method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},"clientInfo":{"name":"kortix-image-warmup","version":"1"}}}' \
    >&"$oc_write_fd"
  await_acp_response 'warmup:initialize' || return 1

  printf '%s\n' \
    "{\"jsonrpc\":\"2.0\",\"id\":\"warmup:session-new\",\"method\":\"session/new\",\"params\":{\"cwd\":\"$cwd\",\"mcpServers\":[]}}" \
    >&"$oc_write_fd"
  await_acp_response 'warmup:session-new' || return 1
}

warm_migration() {
  mkdir -p "$HOME/.local/share" "$HOME/.config" "$HOME/.cache"
  warm_acp /tmp/kortix-opencode-migration-warm /tmp/oc-bake.log
  result=$?
  stop_opencode
  rm -rf /tmp/kortix-opencode-migration-warm
  ready=$([ "$result" = 0 ] && echo 1 || echo 0)
  echo "=== migration-bake: acp-ready=$ready ==="
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
  warm_acp /workspace /tmp/oc-warm.log
  result=$?
  ready=$([ "$result" = 0 ] && echo 1 || echo 0)
  echo "=== instance-warm: acp-ready=$ready ==="
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
