#!/usr/bin/env bash
# Sandbox entrypoint. Runs as PID 1, ensures the workspace directory is
# materialized + stable before handing off to the compiled daemon.
#
# Why this matters: Daytona's runtime can delete the original /workspace
# AFTER our container starts (overlayfs init race). If the daemon launches
# directly via WORKDIR /workspace, its CWD becomes "/workspace (deleted)"
# the moment Daytona's init clobbers the dir, and every fs operation the
# daemon subsequently attempts (Node's mkdir/stat/chdir) silently misbehaves
# — opencode never spawns, materializeRepo never runs, the sandbox sits
# stuck at `opencode: starting` forever.
#
# This script polls for /workspace to exist + be writable for several
# consecutive iterations, mkdir's it if missing, cd's into the verified
# directory, and only then `exec`s the daemon. After exec, the daemon
# inherits a real CWD and can do filesystem work normally.
set -euo pipefail

WORKSPACE="${KORTIX_WORKSPACE:-/workspace}"
DEADLINE_S=120
STABLE_REQUIRED=4
INTERVAL_S=0.5

start=$(date +%s)
stable=0
echo "[entrypoint] waiting for ${WORKSPACE} to stabilize (deadline ${DEADLINE_S}s)" >&2
while :; do
  if mkdir -p "${WORKSPACE}" 2>/dev/null \
      && touch "${WORKSPACE}/.kortix-init-probe" 2>/dev/null \
      && rm -f "${WORKSPACE}/.kortix-init-probe" 2>/dev/null; then
    stable=$((stable + 1))
    if [ "${stable}" -ge "${STABLE_REQUIRED}" ]; then
      echo "[entrypoint] workspace stable after ${stable} probes" >&2
      break
    fi
  else
    if [ "${stable}" -gt 0 ]; then
      echo "[entrypoint] workspace flapped; resetting (stable was ${stable})" >&2
    fi
    stable=0
  fi
  now=$(date +%s)
  if [ $((now - start)) -ge "${DEADLINE_S}" ]; then
    echo "[entrypoint] workspace never stabilized; launching daemon anyway" >&2
    mkdir -p "${WORKSPACE}" 2>/dev/null || true
    break
  fi
  sleep "${INTERVAL_S}"
done

# CRITICAL: cd to / (always exists) before exec'ing the daemon. Daytona's
# runtime can delete /workspace AFTER the entrypoint loop exits — if we
# cd'd into /workspace and exec'd from there, the daemon would inherit a
# "deleted" cwd and every subsequent spawn (git, opencode) would inherit
# it too, failing in confusing ways. Anchoring at / keeps the daemon's
# cwd stable; the daemon itself works with absolute paths under
# ${WORKSPACE} from here on.
cd /
echo "[entrypoint] daemon takeover (cwd=/, workspace=${WORKSPACE})" >&2
exec /usr/local/bin/kortix-agent "$@"
