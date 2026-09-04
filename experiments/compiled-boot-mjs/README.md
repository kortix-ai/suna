# Standalone compiled boot demo

This folder compares two boot paths without importing or starting Kortix. It is
an isolated performance and runtime-update demonstration.

- The old path clones a Git repository, compiles TypeScript into
  `dist/server.mjs`, starts the bundle, and verifies `/health`.
- The new path compiles `server.mjs` before the boot timer. Boot copies only
  that artifact into an empty runtime directory, starts it, and verifies
  `/health`.

The model matches Flue's Node deployment output: a build produces one runnable
`dist/server.mjs` file. This demo uses Bun's built-in bundler, so it has no npm
dependencies.

The production Kortix compiler lives in `apps/api/src/git-proxy`. It generates
a verified `server.mjs` that launches the existing OpenCode-based sandbox
daemon. The production launcher does not use Pi and does not embed OpenCode.

## Requirements

- Bun
- Node.js
- Git

## Run both paths

Run these commands from this folder:

```bash
bun clone-and-compile.mjs
bun run-precompiled.mjs
bun runtime-update-demo.mjs
```

The first run creates a deterministic 16 MiB fixture repository under
`.demo-cache`. Fixture creation is printed separately and excluded from both
boot totals.

The old result includes:

```text
OLD PATH: clone -> compile -> start
  git clone:                ... ms
  compile server.mjs:       ... ms
  start + health:           ... ms
  BOOT TOTAL:               ... ms
```

The new result includes:

```text
NEW PATH: precompiled server.mjs -> start
  precompile (excluded):      ... ms
  deliver server.mjs:        ... ms
  start + health:            ... ms
  BOOT TOTAL:                ... ms
  source present at boot:    false
```

Run the new command with `--rebuild` to rebuild the content-addressed artifact:

```bash
bun run-precompiled.mjs --rebuild
```

Use a smaller or larger generated repository:

```bash
bun clone-and-compile.mjs --files 2000 --file-kb 32
bun run-precompiled.mjs --files 2000 --file-kb 32 --rebuild
```

## What the result means

The new boot path does not parse or compile source code. It does not clone Git.
It receives one `server.mjs` artifact and starts it.

The precompile duration is not hidden. The script prints it outside the boot
total because production must run the compiler when Git state changes, before a
session starts.

This local demo has no network latency. It proves the artifact shape and boot
sequence. Use a real sandbox benchmark to measure production Git and network
latency.

## Live runtime update

`runtime-update-demo.mjs` starts `v1` behind a stable local reverse proxy. It
then performs two updates:

1. It builds and verifies `v2` while `v1` continues to serve requests.
2. It promotes `v2`, routes new requests to it, and drains requests already
   assigned to `v1` before stopping `v1`.
3. It starts an unhealthy candidate, rejects it, and proves `v2` remains live.

The supervisor never overwrites an artifact. A failed build or health check
keeps the active process and its artifact unchanged.

## Test

```bash
bun test
```
