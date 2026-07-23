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

# Some providers start the image as root with only HOME=/ and omit the image
# PATH. Restore the runtime environment before any command resolves.
KORTIX_PATH="/home/kortix/.local/bin:/home/kortix/.local/share/pnpm/bin:/home/kortix/.bun/bin"
case ":${PATH:-}:" in
  *:"${KORTIX_PATH}":*) ;;
  *) PATH="${KORTIX_PATH}:${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" ;;
esac
export PATH

if [ "$(id -u)" -eq 0 ] && id kortix >/dev/null 2>&1; then
  # TEMPORARY: Platinum starts with /dev/shm as a plain directory and low
  # nofile limits. Both settings must be repaired before the privilege drop.
  grep -q " /dev/shm " /proc/mounts \
    || { mkdir -p /dev/shm && mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs /dev/shm; } 2>/dev/null \
    || true
  chmod 1777 /dev/shm 2>/dev/null || true
  ulimit -Hn 1048576 2>/dev/null || true
  ulimit -Sn 1048576 2>/dev/null || true
  export HOME=/home/kortix USER=kortix LOGNAME=kortix SHELL=/bin/bash
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid kortix --regid kortix --init-groups "$0" "$@"
  fi
  exec sudo -u kortix -- env \
    HOME=/home/kortix USER=kortix LOGNAME=kortix PATH="${PATH}" \
    "$0" "$@"
fi

if [ "${HOME:-/}" = "/" ]; then
  export HOME=/home/kortix
fi

WORKSPACE="${KORTIX_WORKSPACE:-/workspace}"
DEADLINE_S=120
# Require 2 consecutive clean probes at a tight 0.25s cadence (~0.5s on the
# common path where the dir is stable immediately) instead of 4×0.5s=2s. The
# daemon also anchors its cwd at / and uses absolute ${WORKSPACE} paths, so a
# brief post-exec flap is already tolerated — 2 probes is enough to clear the
# Daytona overlayfs init race without paying a flat 2s on every boot.
STABLE_REQUIRED=2
INTERVAL_S=0.25

start=$(date +%s)
stable=0
echo "[entrypoint] waiting for ${WORKSPACE} to stabilize (deadline ${DEADLINE_S}s)" >&2
while :; do
  # Providers may replace /workspace with a fresh root-owned directory after
  # the image starts. Repair only the mountpoint ownership (never recursively
  # chown a materialized repository) before testing it as the runtime user.
  if { mkdir -p "${WORKSPACE}" 2>/dev/null \
        && touch "${WORKSPACE}/.kortix-init-probe" 2>/dev/null; } \
      || { sudo mkdir -p "${WORKSPACE}" \
        && sudo chown "$(id -u):$(id -g)" "${WORKSPACE}" \
        && touch "${WORKSPACE}/.kortix-init-probe"; } \
      && test -w "${WORKSPACE}" \
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
    mkdir -p "${WORKSPACE}" 2>/dev/null \
      || { sudo mkdir -p "${WORKSPACE}" && sudo chown "$(id -u):$(id -g)" "${WORKSPACE}"; } \
      || true
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
