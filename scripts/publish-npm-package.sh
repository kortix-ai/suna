#!/usr/bin/env bash
# Publish the npm package in the current working directory, in lockstep with the
# platform release version ($VERSION). Builds dist/, stages the published
# manifest (dist-pointing entrypoints + pinned workspace deps + version lock),
# dry-packs it, and publishes idempotently.
#
# Auth is Trusted Publishing (OIDC) when the job grants id-token, else the
# NPM_TOKEN automation token (NODE_AUTH_TOKEN). With neither, it skips cleanly so
# a release is never blocked. Re-running the same release is a no-op (it skips a
# version already on npm rather than hard-failing on E409).
#
# Run from the package directory with VERSION (and optionally NODE_AUTH_TOKEN) in
# the environment:
#
#   VERSION=1.2.3 bash ../../scripts/publish-npm-package.sh
#
set -euo pipefail

: "${VERSION:?VERSION env is required}"

# Trusted Publishing (OIDC) requires npm >= 11.5.1; node 22 ships npm 10.
npm install -g npm@latest
echo "npm $(npm --version)"

# Publish only if SOME auth path is available: OIDC (id-token granted →
# ACTIONS_ID_TOKEN_REQUEST_URL set) or a fallback automation token.
if [ -z "${NODE_AUTH_TOKEN:-}" ] && [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  echo "::warning::No npm auth (no OIDC, no NPM_TOKEN) — skipping publish."
  exit 0
fi

name="$(node -p "require('./package.json').name")"

echo "Building ${name}@${VERSION}"
# Prefer build:bundles when the package declares one (today: @kortix/sdk,
# which also emits the tsup browser bundles — dist/kortix.esm.min.js and
# dist/kortix.global.js — that publishConfig.browser/unpkg/jsdelivr point at.
# stage-npm-publish.mjs promotes those fields and then verifies they exist in
# dist/, so they must be built before it runs, not just before `npm publish`
# (whose prepublishOnly lifecycle script fires too late for that check).
# Packages with no CDN bundle (@kortix/llm-catalog, @kortix/executor-sdk) have
# no build:bundles script and fall back to the plain build unchanged.
if node -e "process.exit(require('./package.json').scripts?.['build:bundles'] ? 0 : 1)"; then
  bun run build:bundles
else
  bun run build
fi

# Stage the manifest npm actually publishes (dist entrypoints, pinned workspace
# deps, version lock) from the package's own publishConfig, and verify dist/.
VERSION="$VERSION" node ../../scripts/stage-npm-publish.mjs

npm pack --dry-run

# Idempotent: a re-run of the same release must not hard-fail on E409.
if npm view "${name}@${VERSION}" version >/dev/null 2>&1; then
  echo "${name}@${VERSION} already on npm — skipping (idempotent re-run)."
  exit 0
fi

# With TP configured + OIDC available, npm publishes via OIDC (+provenance) and
# ignores the token; otherwise it falls back to NODE_AUTH_TOKEN.
npm publish
echo "Published ${name}@${VERSION} ✅"
