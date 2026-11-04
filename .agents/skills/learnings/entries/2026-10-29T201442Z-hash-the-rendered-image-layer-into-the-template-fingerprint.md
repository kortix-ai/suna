---
recorded: 2026-10-29T20:14:42Z
incident_date: 2026-10-29
---
# Hash the rendered image layer into the template fingerprint; never rely on a manual version bump

**Rule:** Derive the template fingerprint from the rendered layer text (`kortixToolchainLayer` and `kortixArtifactLayer`), not from a hand-bumped `RUNTIME_LAYER_VERSION` alone. A layer edit must produce a new image name with no second edit.

**Trigger surface:** Editing `packages/shared/src/sandbox/dockerfile-layer.ts`, `desktop.ts`, or anything else that renders into the standard image layer, or changing `apps/api/src/snapshots/template-runtime-fingerprint.ts`.

**Incident:** 2026-10-29, branch `sandbox-desktop` (the session desktop). The desktop install step was added to the layer, but the fingerprint hashed only pinned versions and `RUNTIME_LAYER_VERSION`. Later edits to the layer kept the same image name, so local sessions waited on a build of the earlier layer text. Merged that way, a layer edit without a version bump reaches no session. Caught before merge, in local verification. No user impact.

**Enforcement:** Structural: `RENDERED_LAYER_HASH` in `template-runtime-fingerprint.ts` hashes the rendered layer text into `runtimeIntegrityKey`, so every layer edit changes the image name. No test asserts it yet: the fingerprint tests need the full API env.
