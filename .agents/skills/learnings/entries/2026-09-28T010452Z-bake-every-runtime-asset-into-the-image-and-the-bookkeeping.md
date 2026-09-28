---
recorded: 2026-09-28T01:04:52Z
incident_date: 2026-09-27
---
# Bake every runtime asset into the image AND the bookkeeping that names it

**Rule:** When an image bakes a converged runtime asset, bake the state file that
names its digest in the same build. Bytes without bookkeeping still re-download:
the daemon short-circuits on the RECORDED hash, not on the file being present.
Add the assertion to every image definition at once — an option that only one
image passes is how the next divergence ships.

**Trigger surface:** Editing `kortixArtifactLayer`, `buildMetaSandboxDockerfile`,
`apps/sandbox/Dockerfile`, `stageBuildContext`, or anything the daemon converges
in `runtime-assets.ts`.

**Incident:** 2026-09-27, PR #7877. `/opt/kortix/managed-skills` was baked by the
meta image only; `KortixArtifactLayerOpts` had no field for it, so every ordinary
session sandbox on dev, prod and preview booted with nothing to overlay. No image
wrote `/opt/kortix/runtime-assets-state.json` at all, so a cold box answered
`runtime.running` with all-nulls until its first reconcile finished — measured
~140 s on a cold preview box — and that pass downloaded the whole overlay and
re-hashed ~210 MB of binaries to learn nothing had changed. `assertContextComplete`
in `build-context.ts` would have caught the staging half; it was declared and never
called, so it guarded nothing.

**Enforcement:** `packages/shared/src/sandbox/__tests__/platform-binaries.test.ts`
asserts `SANDBOX_MANAGED_SKILLS_DIR` and `SANDBOX_RUNTIME_ASSETS_STATE_COMMAND` on
all three image definitions, and pins them to the daemon's own constants.
`apps/kortix-sandbox-agent-server/src/__tests__/runtime-assets.test.ts` proves the
first reconcile on a baked box fetches the manifest and nothing else.
`assertContextComplete` now runs and lists `managed-skills`.
