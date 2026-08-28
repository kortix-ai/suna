#!/usr/bin/env bash
# Build the worker runtime bundle: one self-contained .mjs, nothing resolved at
# runtime. The API's compiled-boot pipeline prepends per-(project, sha) config
# and a manifest marker to this file — see
# apps/api/src/git-proxy/compiled-pi-runtime.ts.
#
# --target=node: the worker image runs plain node on Alpine (spike-verified:
# 138 MB image, ~250 ms to serving).
set -euo pipefail
cd "$(dirname "$0")/.."
bun install --frozen-lockfile
bun build src/main.ts --target=node --format=esm --minify --outfile dist/worker-runtime.mjs
node -e "const s=require('fs').readFileSync('dist/worker-runtime.mjs','utf8'); if(!s.includes('kortix-worker starting')) { console.error('sentinel missing from bundle'); process.exit(1); } console.log('worker-runtime.mjs', s.length, 'bytes')"
