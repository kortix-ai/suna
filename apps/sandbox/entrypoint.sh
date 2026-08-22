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
  # -E keeps the caller's environment. sudo's default env_reset drops every
  # KORTIX_* var, so the daemon would come up with no session identity — no
  # egress shim, no CLI auth — and still pass its health check. The explicit
  # assignments after `env` continue to win for the four they name. setpriv
  # ships on the base image so this fallback should never run, which is exactly
  # why a silent env loss here would be so hard to spot.
  exec sudo -E -u kortix -- env \
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

# ---------------------------------------------------------------------------
# Supervisor — the daemon's own updater.
#
# The image is a cache, not the truth: a box provisioned months ago otherwise
# runs a months-old daemon forever, because restart/resume suspend the same VM
# and a warm fork adopts a captured disk. None of them re-run the image build.
#
# A process cannot safely overwrite its own running binary, so the daemon never
# replaces itself. It STAGES ${AGENT_NEXT} (+ .sha256) and exits ${SWAP_CODE}
# to ask for the swap. This loop performs it. See
# docs/specs/2026-08-20-convergent-runtime.md.
#
# Everything here is failure-biased toward "keep running the binary that
# worked": a bad artifact, a bad digest, or a new binary that will not stay up
# leaves a working box, never a bricked one.
# ---------------------------------------------------------------------------
# The baked binary is the PERMANENT FLOOR: root-owned, never written by anything
# at runtime (we run as `kortix` — see the privilege drop above — so we could not
# overwrite it even if we wanted to). Updates install alongside it in the
# kortix-owned state dir, and the supervisor prefers the updated one when it is
# present and executable.
#
# This is what makes a bricked box impossible rather than merely unlikely:
# rollback in the worst case is "delete one file", after which the box boots the
# binary that shipped in the image.
#
# Overridable so the supervisor logic is testable without root or a real image;
# production never sets these. See apps/sandbox/scripts/test-entrypoint-swap.sh.
AGENT_BAKED="${KORTIX_AGENT_BIN:-/usr/local/bin/kortixd}"
AGENT_STATE_DIR="${KORTIX_AGENT_STATE_DIR:-/opt/kortix}"
AGENT_CURRENT="${AGENT_STATE_DIR}/agent.current"
AGENT_NEXT="${AGENT_STATE_DIR}/agent.next"
AGENT_PREV="${AGENT_STATE_DIR}/agent.prev"
AGENT_PINNED="${AGENT_STATE_DIR}/agent.pinned"
# EX_TEMPFAIL. Distinguishes "swap me and restart" from a crash: any other exit
# code counts against the failure budget below, so a crash-looping NEW binary
# rolls back while a crash-looping OLD one never triggers an update.
SWAP_CODE=75
# A relaunched binary must survive this long to count as good. Shorter than any
# real session, longer than a binary that dies on startup.
HEALTHY_AFTER_S=60
# Consecutive early exits after a swap before we give up and pin.
MAX_EARLY_EXITS=2

early_exits=0

# Move a verified staged binary into place. Any failure leaves the live binary
# untouched — the caller simply relaunches what is already there.
promote_staged_agent() {
  [ -f "${AGENT_NEXT}" ] || return 1
  if [ -f "${AGENT_PINNED}" ]; then
    echo "[entrypoint] update pinned after rollback; discarding staged agent" >&2
    rm -f "${AGENT_NEXT}" "${AGENT_NEXT}.sha256"
    return 1
  fi
  # Re-verify independently. The daemon that wrote this file is exactly the
  # component being replaced, so its correctness is not assumed here.
  if [ -f "${AGENT_NEXT}.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
    expected=$(tr -d '[:space:]' < "${AGENT_NEXT}.sha256")
    actual=$(sha256sum "${AGENT_NEXT}" | cut -d' ' -f1)
    if [ "${expected}" != "${actual}" ]; then
      echo "[entrypoint] staged agent digest mismatch; discarding" >&2
      rm -f "${AGENT_NEXT}" "${AGENT_NEXT}.sha256"
      return 1
    fi
  else
    echo "[entrypoint] staged agent has no verifiable digest; discarding" >&2
    rm -f "${AGENT_NEXT}" "${AGENT_NEXT}.sha256"
    return 1
  fi
  # Keep the binary that was running as the rollback target BEFORE overwriting.
  # Only a previously-updated binary is worth keeping; the baked one is always
  # on disk anyway, so there is nothing to preserve on the first update.
  if [ -f "${AGENT_CURRENT}" ]; then
    cp -f "${AGENT_CURRENT}" "${AGENT_PREV}" 2>/dev/null || true
  fi
  chmod 0755 "${AGENT_NEXT}" 2>/dev/null || true
  # rename(2) within the same filesystem: no reader can see a partial binary.
  if mv -f "${AGENT_NEXT}" "${AGENT_CURRENT}" 2>/dev/null; then
    rm -f "${AGENT_NEXT}.sha256"
    echo "[entrypoint] agent updated from staged binary" >&2
    return 0
  fi
  echo "[entrypoint] could not install staged agent; keeping current" >&2
  rm -f "${AGENT_NEXT}" "${AGENT_NEXT}.sha256"
  return 1
}

# Which binary to launch. An updated one when it is present and executable,
# otherwise the binary that shipped in the image.
select_agent() {
  if [ -x "${AGENT_CURRENT}" ]; then
    echo "${AGENT_CURRENT}"
  else
    echo "${AGENT_BAKED}"
  fi
}

# Undo the last update. Restores the previous updated binary when there is one,
# otherwise drops back to the baked binary by simply removing the override —
# which is why a box can never be bricked by an update: the floor is a file that
# runtime code cannot write.
rollback_agent() {
  [ -f "${AGENT_CURRENT}" ] || return 1
  if [ -f "${AGENT_PREV}" ]; then
    mv -f "${AGENT_PREV}" "${AGENT_CURRENT}" 2>/dev/null || return 1
    chmod 0755 "${AGENT_CURRENT}" 2>/dev/null || true
    echo "[entrypoint] rolled back to previous agent and pinned updates off" >&2
  else
    rm -f "${AGENT_CURRENT}" 2>/dev/null || return 1
    echo "[entrypoint] dropped back to the baked agent and pinned updates off" >&2
  fi
  # Latch it. Without this the box would re-stage the same bad build on every
  # boot and crash-loop forever.
  : > "${AGENT_PINNED}"
  return 0
}

mkdir -p "${AGENT_STATE_DIR}" 2>/dev/null || true

echo "[entrypoint] daemon takeover (cwd=/, workspace=${WORKSPACE})" >&2
while :; do
  # A staged binary from the previous run is installed before launch, never
  # while the daemon it replaces is running.
  promote_staged_agent || true

  agent_bin="$(select_agent)"
  started=$(date +%s)
  set +e
  "${agent_bin}" "$@"
  status=$?
  set -e
  ran=$(( $(date +%s) - started ))

  if [ "${status}" -eq "${SWAP_CODE}" ]; then
    echo "[entrypoint] daemon requested update swap (ran ${ran}s)" >&2
    early_exits=0
    continue
  fi

  # Anything else is the daemon exiting on its own terms. Honour it — this is
  # PID 1 and the provider decides what a stopped sandbox means — unless it
  # FAILED fast right after we swapped in a new binary, which is the one case
  # where the update itself is the prime suspect.
  #
  # `status != 0` is load-bearing. A clean exit is the daemon choosing to stop
  # (a stopped sandbox, a drained box) and must never be read as a bad update:
  # counting it would roll back and pin a perfectly healthy binary purely
  # because the box was short-lived.
  # `AGENT_CURRENT` — not `AGENT_PREV` — is the test for "we are running an
  # updated binary". The FIRST update has no predecessor to keep, so keying off
  # AGENT_PREV would leave exactly the first bad rollout unable to roll back,
  # which is the rollout most likely to be bad.
  if [ "${status}" -ne 0 ] \
     && [ "${ran}" -lt "${HEALTHY_AFTER_S}" ] \
     && [ -f "${AGENT_CURRENT}" ] \
     && [ ! -f "${AGENT_PINNED}" ]; then
    early_exits=$(( early_exits + 1 ))
    echo "[entrypoint] agent exited ${status} after ${ran}s (early exit ${early_exits}/${MAX_EARLY_EXITS})" >&2
    if [ "${early_exits}" -ge "${MAX_EARLY_EXITS}" ] && rollback_agent; then
      early_exits=0
      continue
    fi
    [ "${early_exits}" -lt "${MAX_EARLY_EXITS}" ] && continue
  fi

  echo "[entrypoint] agent exited ${status} after ${ran}s; exiting" >&2
  exit "${status}"
done
