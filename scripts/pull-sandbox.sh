#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pull-sandbox.sh — Pull the sandbox Docker image with retry logic
#
# Usage:
#   SANDBOX_IMAGE=kortix/computer:latest ./scripts/pull-sandbox.sh
#
# Environment:
#   SANDBOX_IMAGE   Docker image to pull (default: kortix/computer:latest)
#
# Exit codes:
#   0   Image is available locally (either already present or pulled successfully)
#   1   Failed to pull image after exhausting all retries
# ---------------------------------------------------------------------------
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${SANDBOX_IMAGE:-kortix/computer:latest}"

CLEANUP_DONE=false

cleanup() {
  if [ "$CLEANUP_DONE" = false ]; then
    CLEANUP_DONE=true
    :
  fi
}

trap cleanup EXIT INT TERM

# ── 1. Check Docker daemon ──────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "[pull-sandbox] ERROR: Docker daemon is not running." >&2
  echo "[pull-sandbox] Please start Docker and try again." >&2
  exit 1
fi

# ── 2. Check if image already exists locally ────────────────────────────
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "[pull-sandbox] $IMAGE already exists locally."
  exit 0
fi

echo "[pull-sandbox] $IMAGE not found locally. Attempting to pull..."

# ── 3. Pull with retry (inline Python) ──────────────────────────────────
python3 - <<PY
import subprocess
import sys
import time

image = "$IMAGE"
max_retries = 5
backoff_seconds = [2, 4, 8, 16, 30]

last_stderr = ""

for attempt in range(1, max_retries + 1):
    print(f"[pull-sandbox] Pull attempt {attempt}/{max_retries}...", flush=True)
    result = subprocess.run(
        ["docker", "pull", image],
        capture_output=True,
        text=True,
    )
    stderr = (result.stderr or "").strip()
    last_stderr = stderr

    if result.returncode == 0:
        print(f"[pull-sandbox] Successfully pulled {image}.", flush=True)
        sys.exit(0)

    # Determine if this is a transient error worth retrying
    stderr_lower = stderr.lower()
    is_transient = False

    transient_patterns = [
        "timeout",
        "lookup",
        "connection refused",
        "i/o timeout",
        "connection reset by peer",
        "no such host",
        "temporary failure in name resolution",
        "403",
        "429",
        "500",
        "502",
        "503",
    ]

    for pattern in transient_patterns:
        if pattern in stderr_lower:
            is_transient = True
            break

    # Also check stdout for HTTP status codes
    stdout = (result.stdout or "").strip()
    stdout_lower = stdout.lower()
    for code in ["401", "403", "429"]:
        if code in stdout:
            is_transient = True
            break

    # Check if it's a permanent error (e.g., manifest not found)
    is_permanent = False
    permanent_patterns = [
        "manifest for .* not found",
        "not found",
        "repository does not exist",
        "access denied",
        "denied",
        "authentication required",
    ]
    for pattern in permanent_patterns:
        if pattern in stderr_lower or pattern in stdout_lower:
            is_permanent = True
            break

    if is_permanent:
        print(
            f"[pull-sandbox] ERROR: Permanent error pulling {image}.",
            file=sys.stderr,
        )
        if stderr:
            print(f"  Details: {stderr}", file=sys.stderr)
        print(
            f"[pull-sandbox] The image does not exist or you do not have access.",
            file=sys.stderr,
        )
        print(
            f"[pull-sandbox] Check the image name and your Docker credentials.",
            file=sys.stderr,
        )
        sys.exit(1)

    if is_transient and attempt < max_retries:
        delay = backoff_seconds[attempt - 1]
        print(
            f"[pull-sandbox] Transient error detected. Retrying in {delay}s...",
            flush=True,
        )
        if stderr:
            sys.stderr.write(f"  stderr: {stderr}\n")
        time.sleep(delay)
        continue
    elif is_transient and attempt == max_retries:
        # Final attempt failed with transient error
        break
    else:
        # Non-transient, non-permanent error — retry anyway with backoff
        if attempt < max_retries:
            delay = backoff_seconds[attempt - 1]
            print(
                f"[pull-sandbox] Pull failed. Retrying in {delay}s...",
                flush=True,
            )
            if stderr:
                sys.stderr.write(f"  stderr: {stderr}\n")
            time.sleep(delay)
        continue

# All retries exhausted
print(f"[pull-sandbox] ERROR: Failed to pull {image} after {max_retries} attempts.", file=sys.stderr)
if last_stderr:
    print(f"  Last error: {last_stderr}", file=sys.stderr)
print(f"[pull-sandbox] Possible causes:", file=sys.stderr)
print(f"  - Network connectivity issues", file=sys.stderr)
print(f"  - Docker Hub / registry is unreachable", file=sys.stderr)
print(f"  - Rate limiting (too many pulls)", file=sys.stderr)
print(f"[pull-sandbox] You can try:", file=sys.stderr)
print(f"  1. Check your network connection", file=sys.stderr)
print(f"  2. Run 'docker login' if using a private registry", file=sys.stderr)
print(f"  3. Pull manually: docker pull {image}", file=sys.stderr)
sys.exit(1)
PY
PULL_EXIT_CODE=$?

# ── 4. Verify image integrity after pull ────────────────────────────────
if [ "$PULL_EXIT_CODE" -eq 0 ]; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "[pull-sandbox] Verified $IMAGE is present and intact."
    exit 0
  else
    echo "[pull-sandbox] ERROR: Image pull reported success but 'docker image inspect' failed." >&2
    echo "[pull-sandbox] The image may be corrupted. Try pulling manually." >&2
    exit 1
  fi
else
  exit "$PULL_EXIT_CODE"
fi
