#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'EOF'
scripts/start-sandbox.sh was the legacy JustAVPS snapshot bootstrapper.

Repo-first Kortix v1 does not use this host-level workload wrapper. Build the
provider-neutral sandbox image from apps/sandbox and run sessions through the
API provider layer instead:

  docker build -f apps/sandbox/Dockerfile -t kortix/sandbox:dev .
  ALLOWED_SANDBOX_PROVIDERS=local_docker pnpm --filter kortix-api dev

Production cloud sandboxes use the Daytona provider with a snapshot built from
the same apps/sandbox image. This script is intentionally fail-closed so stale
core/ startup paths cannot come back as an active runtime dependency.
EOF

exit 1
