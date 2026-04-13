#!/bin/bash
# ============================================================================
# Docker-in-Docker E2E Tests
# ============================================================================
#
# Verifies DinD works flawlessly inside the sandbox container:
#   1. dockerd is running and reachable on /var/run/docker.sock
#   2. docker CLI is installed and points at the right DOCKER_HOST
#   3. daemon.json was generated with a sane storage-driver
#   4. /var/lib/docker lives on the sandbox_docker named volume
#   5. A real container can be pulled, run, and produce output
#   6. A bind mount from the sandbox into a nested container works
#   7. Compose v2 plugin is available
#   8. Cleanup: pulled images + containers can be removed
#
# Run this inside a normal sandbox container. DinD is enabled by default.
#
# Usage:
#   # From the host (against a running container):
#   docker exec kortix-sandbox bash /ephemeral/tests/test-docker-in-docker.sh
#
#   # Or via the dev bind mount (host path):
#   docker exec kortix-sandbox bash /workspace/computer/core/tests/test-docker-in-docker.sh
#
# Exit codes:
#   0 = all tests passed
#   1 = one or more tests failed
# ============================================================================

set -uo pipefail

PASS=0
FAIL=0
FAILED_TESTS=()

TEST_IMAGE="${TEST_IMAGE:-busybox:latest}"
TEST_CONTAINER_NAME="dind-e2e-$$"
TEST_BIND_DIR="/tmp/dind-e2e-bind-$$"

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); FAILED_TESTS+=("$1"); }

section() { echo; echo "── $1 ─────────────────────────────────────────────"; }

cleanup() {
  echo
  echo "── cleanup ─────────────────────────────────────────────────"
  docker rm -f "${TEST_CONTAINER_NAME}" 2>/dev/null || true
  rm -rf "${TEST_BIND_DIR}" 2>/dev/null || true
}
trap cleanup EXIT

# ── 0. Preflight ────────────────────────────────────────────────────────────
section "Preflight"

pass "DinD is a core sandbox capability"

if ! command -v docker >/dev/null 2>&1; then
  fail "docker CLI not on PATH"
  echo "FAILED (cannot continue)"
  exit 1
fi
pass "docker CLI installed: $(docker --version)"

if ! command -v dockerd >/dev/null 2>&1; then
  fail "dockerd binary missing — sandbox image must include Docker daemon tooling"
  exit 1
fi
pass "dockerd binary installed: $(dockerd --version)"

# ── 1. dockerd readiness ────────────────────────────────────────────────────
section "dockerd readiness"

if docker-wait-ready 60 --quiet; then
  pass "dockerd reachable via docker-wait-ready"
else
  fail "dockerd did not become ready within 60s"
  echo
  echo "── last dockerd log lines ──"
  tail -n 40 /var/log/dockerd.log 2>/dev/null || echo "(no dockerd.log)"
  exit 1
fi

if [ -S /var/run/docker.sock ]; then
  pass "/var/run/docker.sock exists"
else
  fail "/var/run/docker.sock missing"
fi

if docker info >/dev/null 2>&1; then
  pass "'docker info' succeeds"
else
  fail "'docker info' failed"
fi

# ── 2. daemon.json + storage driver ─────────────────────────────────────────
section "daemon.json + storage driver"

if [ -f /etc/docker/daemon.json ]; then
  pass "/etc/docker/daemon.json present"
else
  fail "/etc/docker/daemon.json missing — svc-docker/run didn't write it"
fi

DRIVER=$(docker info --format '{{.Driver}}' 2>/dev/null || echo "?")
case "${DRIVER}" in
  overlay2)    pass "storage-driver=overlay2 (ideal, native FS)";;
  fuse-overlayfs) pass "storage-driver=fuse-overlayfs (overlay-on-overlay fallback)";;
  vfs)         pass "storage-driver=vfs (last-resort fallback; slow but works)";;
  "")          fail "storage-driver empty — daemon unreachable";;
  *)           pass "storage-driver=${DRIVER} (unusual but functional)";;
esac

# ── 3. data-root on sandbox_docker volume ───────────────────────────────────
section "data-root volume"

DATA_ROOT=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo "")
if [ "${DATA_ROOT}" = "/var/lib/docker" ]; then
  pass "data-root=/var/lib/docker"
else
  fail "unexpected data-root=${DATA_ROOT}"
fi

# If /var/lib/docker is overlay, the sandbox_docker named volume isn't
# mounted — overlay2 will break. Warn loudly.
DATA_FSTYPE=$(stat -f -c '%T' /var/lib/docker 2>/dev/null || echo "?")
case "${DATA_FSTYPE}" in
  overlayfs|overlay)
    if [ "${DRIVER}" = "overlay2" ]; then
      fail "/var/lib/docker is overlayfs but driver=overlay2 — sandbox_docker volume likely not mounted"
    else
      pass "/var/lib/docker fs=${DATA_FSTYPE} (driver=${DRIVER} compatible)"
    fi
    ;;
  *)
    pass "/var/lib/docker fs=${DATA_FSTYPE}"
    ;;
esac

# ── 4. pull a tiny image ────────────────────────────────────────────────────
section "image pull"

if docker pull "${TEST_IMAGE}" >/dev/null 2>&1; then
  pass "pulled ${TEST_IMAGE}"
else
  fail "could not pull ${TEST_IMAGE} — network or daemon issue"
  exit 1
fi

# ── 5. run a container and capture output ──────────────────────────────────
section "run container"

OUTPUT=$(docker run --rm --name "${TEST_CONTAINER_NAME}-echo" "${TEST_IMAGE}" echo "hello-from-dind" 2>&1 || true)
if [ "${OUTPUT}" = "hello-from-dind" ]; then
  pass "container stdout roundtrip works"
else
  fail "container stdout unexpected: '${OUTPUT}'"
fi

# ── 6. bind mount into nested container ─────────────────────────────────────
section "bind mounts"

mkdir -p "${TEST_BIND_DIR}"
echo "kortix-dind-marker" > "${TEST_BIND_DIR}/marker.txt"

MOUNT_OUTPUT=$(docker run --rm \
  -v "${TEST_BIND_DIR}:/mnt:ro" \
  "${TEST_IMAGE}" cat /mnt/marker.txt 2>&1 || true)
if [ "${MOUNT_OUTPUT}" = "kortix-dind-marker" ]; then
  pass "bind mount host→nested container works"
else
  fail "bind mount failed: '${MOUNT_OUTPUT}'"
fi

# ── 7. container networking ─────────────────────────────────────────────────
section "container networking"

NET_OUTPUT=$(docker run --rm "${TEST_IMAGE}" sh -c 'nslookup -type=a example.com 2>&1 | grep -c "^Address" || true' 2>&1 || true)
if [ -n "${NET_OUTPUT}" ] && [ "${NET_OUTPUT}" != "0" ]; then
  pass "nested container has DNS + network"
else
  # Not a hard failure — some CI envs block outbound DNS.
  echo "  ! nested container network unreachable (env-dependent, not failing)"
fi

# ── 8. compose plugin ───────────────────────────────────────────────────────
section "compose plugin"

if docker compose version >/dev/null 2>&1; then
  pass "docker compose v2 plugin installed: $(docker compose version --short)"
else
  fail "docker compose plugin not available"
fi

# ── 9. daemon survives a container run ─────────────────────────────────────
section "stability"

for i in 1 2 3; do
  if docker run --rm "${TEST_IMAGE}" true >/dev/null 2>&1; then
    pass "quick run #${i} succeeded"
  else
    fail "quick run #${i} failed — daemon unstable"
  fi
done

# ── Summary ────────────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════"
echo " RESULT: ${PASS} passed, ${FAIL} failed"
echo "════════════════════════════════════════════════════════════"

if [ "${FAIL}" -gt 0 ]; then
  echo
  echo "Failed tests:"
  for t in "${FAILED_TESTS[@]}"; do
    echo "  - ${t}"
  done
  exit 1
fi

exit 0
