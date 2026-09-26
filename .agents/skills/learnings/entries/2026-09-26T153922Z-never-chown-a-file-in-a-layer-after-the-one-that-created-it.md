---
recorded: 2026-09-26T15:39:22Z
incident_date: 2026-09-26
---
# Never chown a file in a layer after the one that created it

**Rule:** Set a file's owner and mode in the layer that creates it — `COPY --chown --chmod`,
or a `chown` inside the same `RUN` as the `gunzip`. A `chown` in a LATER layer writes the
inode, which makes overlayfs copy the whole file up into that layer, even when the owner
does not change. Chown the DIRECTORY when what you need is the right to replace a file:
`rename(2)` takes its permission from the directory, never from the file.

**Trigger surface:** Editing `apps/sandbox/Dockerfile`, `packages/shared/src/sandbox/*`,
or any image definition that places a large binary and then adjusts its ownership.

**Incident:** 2026-09-26, PR #7698 on `main`. `SANDBOX_CLI_OWNERSHIP_COMMAND` chowned
`/usr/local/bin` AND `/usr/local/bin/kortix`. On `apps/sandbox/Dockerfile` the CLI arrives
in an earlier layer through `COPY --from=cli-builder --chown=kortix:kortix`, so the file
chown changed nothing and still added a layer the size of the binary. Measured on
linux/arm64 with a 105,000,000-byte stand-in: the `RUN` layer is 105,000,000 bytes with the
file named and 0 bytes without it. The real CLI is 106,678,400 bytes, on every sandbox
image pull. Fixed on `feat/runtime-assets-at-send`; `RUNTIME_LAYER_VERSION` v47 -> v48.

**Enforcement:** `packages/shared/src/sandbox/__tests__/platform-binaries.test.ts` pins
`SANDBOX_CLI_OWNERSHIP_COMMAND` with `toBe` and asserts no image definition contains
`chown kortix:kortix /usr/local/bin /usr/local/bin/kortix`.
