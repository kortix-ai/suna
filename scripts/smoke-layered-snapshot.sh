#!/bin/bash
#
# smoke-layered-snapshot.sh — build the snapshot Dockerfile the way apps/api
# would, without involving Daytona, a project, or a session. Verifies bun +
# agent-cli + install-shims land correctly in a fresh image.
#
# Usage:
#   bash scripts/smoke-layered-snapshot.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTEXT_DIR="$(mktemp -d)"
trap 'rm -rf "$CONTEXT_DIR"' EXIT

echo "→ Build context: $CONTEXT_DIR"

# 1. Dummy user Dockerfile — pretends to be a project's .kortix/Dockerfile.
cat >"$CONTEXT_DIR/user.Dockerfile" <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
EOF

# 2. Generate the layered Dockerfile via the real builder code.
bun --cwd "$REPO_ROOT" -e "
import { buildLayeredDockerfile } from './apps/api/src/snapshots/dockerfile-layer';
import { readFileSync, writeFileSync } from 'node:fs';
const user = readFileSync('$CONTEXT_DIR/user.Dockerfile', 'utf8');
const layered = buildLayeredDockerfile({
  userDockerfile: user,
  opencodeVersion: '1.14.28',
  agentBinaryPath: 'kortix-agent',
  entrypointScriptPath: 'kortix-entrypoint',
  agentCliPath: 'kortix-agent-cli',
});
writeFileSync('$CONTEXT_DIR/Dockerfile', layered);
console.log('→ Layered Dockerfile written, ' + layered.split('\n').length + ' lines');
"

echo "→ Showing the Kortix runtime layer:"
echo "─────────────────────────────────────────"
sed -n '/Kortix runtime layer/,$p' "$CONTEXT_DIR/Dockerfile"
echo "─────────────────────────────────────────"

# 3. Stage the artifacts the layered Dockerfile expects to COPY.
cp "$REPO_ROOT/apps/kortix-sandbox-agent-server/dist/kortix-agent" "$CONTEXT_DIR/kortix-agent" 2>/dev/null \
  || { echo "⚠ kortix-agent binary not built — using empty stub for smoke test"; printf '#!/bin/sh\necho stub-agent\n' >"$CONTEXT_DIR/kortix-agent"; chmod +x "$CONTEXT_DIR/kortix-agent"; }
cp "$REPO_ROOT/apps/sandbox/entrypoint.sh" "$CONTEXT_DIR/kortix-entrypoint"
cp -R "$REPO_ROOT/apps/sandbox/agent-cli" "$CONTEXT_DIR/kortix-agent-cli"

# 4. Build it.
echo "→ docker build…"
docker build -f "$CONTEXT_DIR/Dockerfile" -t kortix/sandbox-layered-smoke:test "$CONTEXT_DIR"

# 5. Verify the CLIs are on PATH and run.
echo "─────────────────────────────────────────"
echo "→ Verifying inside the built image:"
docker run --rm --entrypoint /bin/bash kortix/sandbox-layered-smoke:test -c '
  echo "[bun]     $(which bun) — $(bun --version)"
  echo "[opencode] $(which opencode) — $(opencode --version)"
  echo "[slack]    $(which slack)"
  echo "[kchannel] $(which kchannel)"
  echo "─── slack help ───"
  slack help | head -8
  echo "─── kchannel list (no token) ───"
  kchannel list
'
echo "─────────────────────────────────────────"
echo "✓ Smoke test complete. Image: kortix/sandbox-layered-smoke:test"
