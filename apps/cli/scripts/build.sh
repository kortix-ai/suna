#!/usr/bin/env bash
#
# Compile the `kortix` CLI to a self-contained binary at dist/kortix — the
# artifact the layered snapshot builder bakes into every cloud sandbox
# (apps/api/src/snapshots/providers/daytona.ts reads
# KORTIX_SNAPSHOT_CLI_BIN_PATH, default apps/cli/dist/kortix). Mirrors
# apps/kortix-sandbox-agent-server/scripts/build.sh so both runtime binaries
# are produced the same way (CI, dev-local.sh, the snapshot test harness).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist

if [ -n "${BUN_COMPILE_TARGET:-}" ]; then
  target="$BUN_COMPILE_TARGET"
else
  # Default to bun-linux-x64: Daytona's standard runners are x86_64 and the
  # snapshot builder COPYs this binary verbatim into the per-project image.
  # Override with BUN_COMPILE_TARGET for a different arch (e.g. local docker
  # on Apple Silicon, or a darwin host binary).
  target="bun-linux-x64"
fi

case "$target" in
  bun-linux-x64|bun-linux-arm64|bun-darwin-x64|bun-darwin-arm64) ;;
  *)
    echo "Unsupported Bun compile target: $target" >&2
    exit 1
    ;;
esac

# Version stamp baked into the binary (`kortix --version`, `kortix version`, and
# the CLI's User-Agent). Without it the compiled binary falls back to the literal
# string `dev` (apps/cli/src/index.ts VERSION), which is what made every
# sandbox-baked CLI report `vdev` and hid the fact that production sandboxes ran
# a CLI compiled months before the API it talks to. The API image passes the same
# value it bakes as KORTIX_VERSION (apps/api/Dockerfile, stage `sandbox-cli`), so
# a sandbox CLI now names the deploy it shipped with.
#
# Unset (a plain local `bun run build`) keeps the previous behaviour: no
# `--define`, so the binary reports `dev`.
define_args=()
if [ -n "${KORTIX_CLI_VERSION:-}" ]; then
  define_args+=(--define "process.env.KORTIX_CLI_VERSION=\"${KORTIX_CLI_VERSION}\"")
fi

compile_with_retry() {
  local attempt=1
  local max_attempts=4
  local delay=5

  while true; do
    # `${a[@]+"${a[@]}"}` — expanding an EMPTY array as `"${a[@]}"` under `set -u`
    # is an unbound-variable error on bash 3.2 (the macOS system bash), which
    # would break every local `bun run build`.
    if bun build --compile --target="$target" ${define_args[@]+"${define_args[@]}"} --outfile=dist/kortix src/index.ts; then
      return 0
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      echo "bun build --compile failed after ${max_attempts} attempts" >&2
      return 1
    fi

    echo "bun build --compile failed on attempt ${attempt}/${max_attempts}; retrying in ${delay}s..." >&2
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}

# Refresh the embedded starter snapshot so the compiled binary carries an
# up-to-date copy of the template tree (the on-disk walk does not survive
# `bun build --compile`; see packages/starter/scripts/generate-embedded.ts).
bun run ../../packages/starter/scripts/generate-embedded.ts

# Record the exact in-sandbox Connector source before compilation. The final
# attestation binds that source to the output binary and Linux compile target.
source_digest="$(bun run scripts/sandbox-runtime-attestation.ts print-source)"
attestation_tmp="dist/.kortix-connectors-runtime.attestation.json.tmp"
attestation_final="dist/kortix-connectors-runtime.attestation.json"
compile_with_retry
bun run scripts/sandbox-runtime-attestation.ts write \
  "$attestation_tmp" \
  "dist/kortix" \
  "$source_digest" \
  "$target"
mv "$attestation_tmp" "$attestation_final"
chmod +x dist/kortix
# Sidecar naming the version stamped INTO the binary above. The API serves this
# as `cli_version` on GET /v1/runtime-assets/manifest, so a sandbox can report
# which CLI it is converging on without the API executing a Linux binary. Written
# here — beside the binary it describes — so the two can never be produced apart.
printf '%s\n' "${KORTIX_CLI_VERSION:-dev}" > dist/kortix.version
size="$(stat -f%z dist/kortix 2>/dev/null || stat -c%s dist/kortix)"
echo "Built dist/kortix for ${target} (${size} bytes; version ${KORTIX_CLI_VERSION:-dev}; attestation ${attestation_final})"
